// =========================================
// F1 Hub — cron-worker/src/index.js
//
// Worker separado (Cloudflare Pages Functions NO soporta Cron Triggers
// todavía — confirmado en la documentación oficial: hace falta un
// Worker aparte para tareas programadas). Comparte la misma D1 y el
// mismo KV que el proyecto de Pages vía bindings idénticos.
//
// Dos trabajos, distinguidos por `controller.cron`:
//   */15 * * * *  -> avisa por push si una sesión arranca en breve
//   0 4 * * *     -> recalcula campeonatos históricos por piloto (KV)
// =========================================

import webpush from 'web-push';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const NOTIFY_WINDOW_MIN = 15; // avisar cuando falten <=15 min para la sesión

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(notifyUpcomingSessions(env));
    } else if (controller.cron === '0 4 * * *') {
      ctx.waitUntil(precomputeChampionships(env));
    }
  },

  // Permite probar manualmente pegándole por HTTP (además de --test-scheduled)
  async fetch() {
    return new Response('f1hub-cron worker activo. Este Worker solo responde a Cron Triggers.');
  },
};

// =========================================
// JOB 1: notificaciones de sesiones próximas
// =========================================
async function notifyUpcomingSessions(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.log('Push no configurado (faltan VAPID keys) — se omite este ciclo.');
    return;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@f1hub.pages.dev', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const res = await fetch(`${JOLPICA_BASE}/current.json`, { headers: { 'User-Agent': 'f1hub-cron/1.0' } });
  if (!res.ok) return;
  const data = await res.json();
  const races = data?.MRData?.RaceTable?.Races ?? [];
  const now = Date.now();

  const upcomingSessions = [];
  for (const r of races) {
    for (const session of extractSessions(r)) {
      const diffMin = (new Date(session.dateTimeUTC).getTime() - now) / 60000;
      if (diffMin > 0 && diffMin <= NOTIFY_WINDOW_MIN) {
        upcomingSessions.push({ ...session, raceName: r.raceName });
      }
    }
  }
  if (!upcomingSessions.length) return;

  const subsResult = env.F1_DB ? await env.F1_DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions').all() : null;
  const subscriptions = subsResult?.results ?? [];
  if (!subscriptions.length) return;

  for (const session of upcomingSessions) {
    const notifiedKey = `notified:${session.raceName}:${session.key}`;
    if (env.F1_KV && await env.F1_KV.get(notifiedKey)) continue; // ya avisado en un ciclo anterior

    const payload = JSON.stringify({
      title: `🏁 ${session.label} en ${NOTIFY_WINDOW_MIN} min`,
      body: session.raceName,
      url: '/',
    });

    await Promise.all(subscriptions.map((sub) => sendPush(env, sub, payload)));

    if (env.F1_KV) await env.F1_KV.put(notifiedKey, '1', { expirationTtl: 60 * 60 * 6 }); // 6h, evita duplicados
  }
}

async function sendPush(env, sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
    );
  } catch (err) {
    // 404/410 = la suscripción ya no existe del lado del navegador -> limpiar
    if ((err.statusCode === 404 || err.statusCode === 410) && env.F1_DB) {
      await env.F1_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run().catch(() => {});
    }
  }
}

function extractSessions(r) {
  const sessions = [];
  const push = (key, label) => {
    const s = r[key];
    if (s?.date) sessions.push({ key, label, dateTimeUTC: s.time ? `${s.date}T${s.time}` : `${s.date}T00:00:00Z` });
  };
  push('FirstPractice', 'Práctica 1');
  push('SecondPractice', 'Práctica 2');
  push('ThirdPractice', 'Práctica 3');
  push('SprintQualifying', 'Clasificación Sprint');
  push('Sprint', 'Sprint');
  push('Qualifying', 'Clasificación');
  sessions.push({ key: 'Race', label: 'Carrera', dateTimeUTC: r.time ? `${r.date}T${r.time}` : `${r.date}T00:00:00Z` });
  return sessions;
}

// =========================================
// JOB 2: precálculo de campeonatos por piloto
// =========================================
async function precomputeChampionships(env) {
  if (!env.F1_KV) { console.log('Sin KV — no se puede guardar el precálculo.'); return; }

  const startYear = 1950;
  const endYear = new Date().getUTCFullYear();
  const counts = {}; // driverId -> cantidad de campeonatos

  for (let year = startYear; year <= endYear; year++) {
    try {
      const res = await fetch(`${JOLPICA_BASE}/${year}/driverStandings.json`, { headers: { 'User-Agent': 'f1hub-cron/1.0' } });
      if (res.ok) {
        const data = await res.json();
        const top = data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.[0];
        if (top?.Driver?.driverId) counts[top.Driver.driverId] = (counts[top.Driver.driverId] || 0) + 1;
      }
    } catch { /* si una temporada falla, seguimos con las demás */ }
    await sleep(250); // ser buen vecino del rate limit de Jolpica (200-500/hora compartido)
  }

  await env.F1_KV.put('precomputed:championships', JSON.stringify({ updatedAt: new Date().toISOString(), counts }));
  console.log(`Campeonatos precalculados: ${Object.keys(counts).length} pilotos.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
