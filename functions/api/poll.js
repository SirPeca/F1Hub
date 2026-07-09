// =========================================
// F1 Hub — functions/api/poll.js  (Fase A)  v2 — voto requiere cuenta
//
// GET  /api/poll  -> devuelve la encuesta activa con opciones,
//                     porcentajes, total de votos, y el voto de LA
//                     CUENTA logueada (null si no hay sesión).
// POST /api/poll  { pollId, driverId } -> requiere estar logueado.
//
// CAMBIO DE INTEGRIDAD (v2): antes un voto quedaba atado solo a la
// identidad anónima (cookie del navegador) — borrar cookies o abrir
// una ventana de incógnito permitía votar de nuevo sin límite. Ahora
// votar EXIGE una cuenta, y la unicidad real es (poll_id, user_id) vía
// un índice único parcial en D1 (ver migración 0006) — no se puede
// eludir reinstalando el navegador ni limpiando cookies.
//
// Reglas:
//   - Se auto-crea una fila en gp_polls la primera vez que se consulta
//     una carrera/sprint nueva (season+round+session_type es UNIQUE).
//   - Abre apenas esa carrera pasa a ser "la próxima" y cierra 30 min
//     antes de que largue la sesión correspondiente (Race o Sprint).
//   - Un voto por CUENTA por encuesta (no por navegador/identidad).
//   - Se puede cambiar el voto mientras la encuesta siga abierta.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';
import { checkRateLimit } from '../_lib/ratelimit.js';
import { getUserFromRequest } from '../_lib/session.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ configured: false });

  const target = await resolveTargetRace(env);
  if (!target) return json({ configured: true, poll: null });

  try {
    const poll = await ensurePoll(env.F1_DB, target);
    const user = await getUserFromRequest(request, env.F1_DB);
    const now = Date.now();
    const isOpen = now >= new Date(poll.opens_at).getTime() && now < new Date(poll.closes_at).getTime();
    const isClosed = now >= new Date(poll.closes_at).getTime();

    const [driversRes, votesRes, yourVoteRow] = await Promise.all([
      fetchResilient(`${JOLPICA_BASE}/current/driverStandings.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv: env.F1_KV ?? null, staleKey: 'stale:poll:drivers' }),
      env.F1_DB.prepare('SELECT driver_id, COUNT(*) as votes FROM gp_poll_votes WHERE poll_id = ? GROUP BY driver_id').bind(poll.id).all(),
      user ? env.F1_DB.prepare('SELECT driver_id FROM gp_poll_votes WHERE poll_id = ? AND user_id = ?').bind(poll.id, user.id).first() : null,
    ]);

    const driverList = driversRes.ok
      ? (driversRes.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? []).map((d) => ({
          driverId: d.Driver?.driverId, code: d.Driver?.code, name: `${d.Driver?.givenName} ${d.Driver?.familyName}`,
        }))
      : [];

    const voteCounts = Object.fromEntries((votesRes?.results ?? []).map((r) => [r.driver_id, r.votes]));
    const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);

    const options = driverList.map((d) => ({
      ...d,
      votes: voteCounts[d.driverId] ?? 0,
      percentage: totalVotes ? Math.round(((voteCounts[d.driverId] ?? 0) / totalVotes) * 1000) / 10 : 0,
    }));

    return json({
      configured: true,
      poll: {
        id: poll.id, season: poll.season, round: poll.round, sessionType: poll.session_type,
        raceName: target.raceName, opensAt: poll.opens_at, closesAt: poll.closes_at,
        isOpen, isClosed, totalVotes, options,
        yourVote: yourVoteRow?.driver_id ?? null,
        requiresLogin: !user, // el frontend usa esto para mostrar "iniciá sesión para votar" en vez de los botones
        winnerDriverId: poll.winner_driver_id ?? null,
      },
    });
  } catch {
    return json({ configured: true, poll: null, error: 'server_error' });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  const user = await getUserFromRequest(request, env.F1_DB);
  if (!user) return json({ error: 'login_required' }, 401);

  const allowed = await checkRateLimit(env.F1_KV, `poll-vote:${user.id}`, 20, 300);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { pollId, driverId } = body;
  if (!pollId || !driverId || !/^[a-z0-9_-]{1,40}$/i.test(String(driverId))) {
    return json({ error: 'invalid_fields' }, 400);
  }

  const poll = await env.F1_DB.prepare('SELECT * FROM gp_polls WHERE id = ?').bind(pollId).first();
  if (!poll) return json({ error: 'poll_not_found' }, 404);

  const now = Date.now();
  if (now < new Date(poll.opens_at).getTime()) return json({ error: 'poll_not_open_yet' }, 403);
  if (now >= new Date(poll.closes_at).getTime()) return json({ error: 'poll_closed' }, 403);

  try {
    // UPSERT atómico: una sola operación, sin el patrón frágil de
    // "insertar y si falla actualizar por otra columna" que causaba el
    // bug de votos que no se guardaban (ver migración 0008). Con la
    // tabla reconstruida, la ÚNICA restricción real es (poll_id,
    // user_id), así que el ON CONFLICT puede apuntar a ella directo.
    await env.F1_DB.prepare(`
      INSERT INTO gp_poll_votes (poll_id, identity_id, user_id, driver_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (poll_id, user_id) WHERE user_id IS NOT NULL
      DO UPDATE SET driver_id = excluded.driver_id, voted_at = datetime('now')
    `).bind(pollId, context.data.identityId ?? null, user.id, driverId).run();

    return json({ ok: true });
  } catch {
    return json({ error: 'server_error' }, 500);
  }
}

/** Determina qué carrera/sesión corresponde votar ahora: la que está en
 * curso, o si no hay ninguna, la próxima. */
async function resolveTargetRace(env) {
  const result = await fetchResilient(`${JOLPICA_BASE}/current.json`, {
    fetchOptions: { headers: jolpicaHeaders() }, kv: env.F1_KV ?? null, staleKey: 'stale:poll:calendar',
  });
  if (!result.ok) return null;

  const races = result.data?.MRData?.RaceTable?.Races ?? [];
  const now = Date.now();

  for (const r of races) {
    const raceTime = new Date(r.time ? `${r.date}T${r.time}` : `${r.date}T00:00:00Z`).getTime();
    if (raceTime > now - 3 * 60 * 60 * 1000) {
      const sessionType = r.Sprint ? 'sprint' : 'race';
      const closeSession = r.Sprint ? r.Sprint : { date: r.date, time: r.time };
      const opensAt = new Date().toISOString();
      const rawCloseTime = new Date(closeSession.time ? `${closeSession.date}T${closeSession.time}` : `${closeSession.date}T00:00:00Z`).getTime();
      const closesAt = new Date(rawCloseTime - 30 * 60 * 1000).toISOString();
      return { season: r.season, round: Number(r.round), raceName: r.raceName, sessionType, opensAt, closesAt };
    }
  }
  return null;
}

async function ensurePoll(db, target) {
  await db.prepare(
    'INSERT OR IGNORE INTO gp_polls (season, round, session_type, opens_at, closes_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(target.season, target.round, target.sessionType, target.opensAt, target.closesAt).run();

  await db.prepare(
    'UPDATE gp_polls SET opens_at = MIN(opens_at, ?), closes_at = MIN(closes_at, ?) WHERE season = ? AND round = ? AND session_type = ?'
  ).bind(target.opensAt, target.closesAt, target.season, target.round, target.sessionType).run();

  return db.prepare(
    'SELECT * FROM gp_polls WHERE season = ? AND round = ? AND session_type = ?'
  ).bind(target.season, target.round, target.sessionType).first();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
