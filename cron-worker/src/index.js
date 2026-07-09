// =========================================
// F1 Hub — cron-worker/src/index.js
//
// Worker separado (Cloudflare Pages Functions NO soporta Cron Triggers
// todavía — confirmado en la documentación oficial: hace falta un
// Worker aparte para tareas programadas). Comparte la misma D1 y el
// mismo KV que el proyecto de Pages vía bindings idénticos.
//
// Tres trabajos, distinguidos por `controller.cron`:
//   */15 * * * *  -> avisa por push si una sesión arranca en breve
//   0 4 * * *     -> recalcula campeonatos históricos por piloto (KV)
//   30 4 * * *    -> precalcula estadísticas completas de pilotos
//                    populares (grid actual + leyendas) para que
//                    Comparar/Favoritos no dependan de calcular en vivo
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
    } else if (controller.cron === '30 4 * * *') {
      ctx.waitUntil(precomputeDriverStats(env));
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

// =========================================
// JOB 3: precálculo de estadísticas de Comparar/Favoritos
//
// Esto es el cambio de estrategia para la pestaña Comparar: en vez de
// calcular victorias/podios/poles/temporadas EN EL MOMENTO en que
// alguien mira a un piloto (dependiente de que Jolpica responda bien
// 4-6 consultas justo en ese instante — la causa de fondo de que
// Comparar fuera poco confiable), se precalcula UNA VEZ POR DÍA para
// los pilotos más buscados y se deja listo en KV. compare.js y
// driver-summary.js primero miran acá; si el piloto no está en esta
// lista (alguien poco conocido), recién ahí calculan en vivo como
// respaldo.
// =========================================

// Leyendas retiradas de alta demanda — el grid actual se suma dinámico
// abajo (no hace falta listarlo a mano, cambia cada temporada).
const LEGACY_DRIVER_IDS = [
  'michael_schumacher', 'senna', 'prost', 'vettel', 'alonso', 'raikkonen',
  'button', 'rosberg', 'massa', 'webber', 'hakkinen', 'mansell', 'piquet',
  'lauda', 'stewart', 'clark', 'fangio', 'ricciardo', 'bottas', 'hulkenberg',
  'perez', 'kevin_magnussen',
];

async function precomputeDriverStats(env) {
  if (!env.F1_KV) { console.log('Sin KV — no se puede guardar el precálculo.'); return; }

  const currentIds = await getCurrentGridIds();
  const driverIds = [...new Set([...currentIds, ...LEGACY_DRIVER_IDS])];
  console.log(`Precalculando estadísticas para ${driverIds.length} pilotos…`);

  const results = {};
  for (const id of driverIds) {
    try {
      results[id] = await computeOneDriverStats(id);
    } catch (err) {
      console.log(`Fallo calculando ${id}: ${err.message}`);
    }
    await sleep(300); // ser buen vecino del rate limit compartido de Jolpica
  }

  await env.F1_KV.put('precomputed:driverstats', JSON.stringify({ updatedAt: new Date().toISOString(), drivers: results }));
  console.log(`Estadísticas precalculadas: ${Object.keys(results).length}/${driverIds.length} pilotos.`);
}

async function getCurrentGridIds() {
  try {
    const res = await fetch(`${JOLPICA_BASE}/current/driverStandings.json`, { headers: { 'User-Agent': 'f1hub-cron/1.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [])
      .map((d) => d.Driver?.driverId).filter(Boolean);
  } catch { return []; }
}

async function computeOneDriverStats(id) {
  const [wins, p2, p3, poles, seasons, profile] = await Promise.all([
    totalFor(`${JOLPICA_BASE}/drivers/${id}/results/1.json?limit=1`),
    totalFor(`${JOLPICA_BASE}/drivers/${id}/results/2.json?limit=1`),
    totalFor(`${JOLPICA_BASE}/drivers/${id}/results/3.json?limit=1`),
    totalFor(`${JOLPICA_BASE}/drivers/${id}/qualifying/1.json?limit=1`),
    totalFor(`${JOLPICA_BASE}/drivers/${id}/seasons.json?limit=1`),
    fetch(`${JOLPICA_BASE}/drivers/${id}.json`, { headers: { 'User-Agent': 'f1hub-cron/1.0' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.MRData?.DriverTable?.Drivers?.[0] ?? null),
  ]);

  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;
  return {
    driverId: id,
    name: profile ? `${profile.givenName} ${profile.familyName}` : id,
    nationality: profile?.nationality ?? null,
    wins: wins_,
    podiums: wins_ + p2_ + p3_,
    poles: poles ?? 0,
    seasons: seasons ?? null,
  };
}

async function totalFor(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'f1hub-cron/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const n = Number(data?.MRData?.total);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
