// =========================================
// F1 Hub — functions/api/poll.js  (Fase A)
//
// GET  /api/poll  -> devuelve la encuesta activa (o la próxima a abrir)
//                     con opciones, porcentajes, total de votos y si
//                     ESTA identidad ya votó.
// POST /api/poll  { driverId } -> emite el voto de esta identidad.
//
// Reglas:
//   - Se auto-crea una fila en gp_polls la primera vez que se consulta
//     una carrera/sprint nueva (season+round+session_type es UNIQUE).
//   - Abre al comenzar el fin de semana (misma ventana que "liveWeekend"
//     de /api/calendar) y cierra en el momento exacto en que larga la
//     sesión correspondiente (Race o Sprint) — después de eso el voto
//     ya no tiene gracia.
//   - Un voto por identidad por encuesta (constraint UNIQUE en D1).
//   - Las opciones de piloto salen de la tabla de posiciones actual
//     (grid activo), no de un catálogo hardcodeado que se desactualiza.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!env.F1_DB) return json({ configured: false, note: 'F1_DB no está bindeado.' });

  const target = await resolveTargetRace(env);
  if (!target) return json({ configured: true, poll: null, note: 'No hay ningún Gran Premio próximo.' });

  const poll = await ensurePoll(env.F1_DB, target);
  const now = Date.now();
  const isOpen = now >= new Date(poll.opens_at).getTime() && now < new Date(poll.closes_at).getTime();
  const isClosed = now >= new Date(poll.closes_at).getTime();

  const [driversRes, votesRes, yourVoteRow] = await Promise.all([
    fetchResilient(`${JOLPICA_BASE}/current/driverStandings.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv: env.F1_KV ?? null, staleKey: 'stale:poll:drivers' }),
    env.F1_DB.prepare('SELECT driver_id, COUNT(*) as votes FROM gp_poll_votes WHERE poll_id = ? GROUP BY driver_id').bind(poll.id).all(),
    data.identityId ? env.F1_DB.prepare('SELECT driver_id FROM gp_poll_votes WHERE poll_id = ? AND identity_id = ?').bind(poll.id, data.identityId).first() : null,
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
      winnerDriverId: poll.winner_driver_id ?? null,
    },
  });
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  if (!data.identityId) return json({ error: 'no_identity' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { pollId, driverId } = body;
  if (!pollId || !driverId) return json({ error: 'missing_fields' }, 400);

  const poll = await env.F1_DB.prepare('SELECT * FROM gp_polls WHERE id = ?').bind(pollId).first();
  if (!poll) return json({ error: 'poll_not_found' }, 404);

  const now = Date.now();
  if (now < new Date(poll.opens_at).getTime()) return json({ error: 'poll_not_open_yet' }, 403);
  if (now >= new Date(poll.closes_at).getTime()) return json({ error: 'poll_closed' }, 403);

  try {
    await env.F1_DB.prepare(
      'INSERT INTO gp_poll_votes (poll_id, identity_id, driver_id) VALUES (?, ?, ?)'
    ).bind(pollId, data.identityId, driverId).run();
  } catch {
    // UNIQUE(poll_id, identity_id) ya cubierto: si falla es porque ya votó.
    // Permitimos "cambiar el voto" mientras la encuesta siga abierta.
    await env.F1_DB.prepare(
      'UPDATE gp_poll_votes SET driver_id = ?, voted_at = datetime("now") WHERE poll_id = ? AND identity_id = ?'
    ).bind(driverId, pollId, data.identityId).run();
  }

  return json({ ok: true });
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
    // primera carrera cuyo horario todavía no pasó -> es la que corresponde votar
    // (cubre tanto "en curso esta semana" como "la próxima")
    if (raceTime > now - 3 * 60 * 60 * 1000) {
      const sessionType = r.Sprint ? 'sprint' : 'race';
      const closeSession = r.Sprint ? r.Sprint : { date: r.date, time: r.time };
      const opensAt = weekendStart(r);
      const closesAt = new Date(closeSession.time ? `${closeSession.date}T${closeSession.time}` : `${closeSession.date}T00:00:00Z`).toISOString();
      return { season: r.season, round: Number(r.round), raceName: r.raceName, sessionType, opensAt, closesAt };
    }
  }
  return null;
}

function weekendStart(r) {
  const sessionDates = [r.FirstPractice, r.SprintQualifying, r.Sprint, r.SecondPractice, r.ThirdPractice, r.Qualifying]
    .filter(Boolean)
    .map((s) => new Date(s.time ? `${s.date}T${s.time}` : `${s.date}T00:00:00Z`).getTime());
  return new Date(sessionDates.length ? Math.min(...sessionDates) : Date.now()).toISOString();
}

async function ensurePoll(db, target) {
  await db.prepare(
    'INSERT OR IGNORE INTO gp_polls (season, round, session_type, opens_at, closes_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(target.season, target.round, target.sessionType, target.opensAt, target.closesAt).run();

  return db.prepare(
    'SELECT * FROM gp_polls WHERE season = ? AND round = ? AND session_type = ?'
  ).bind(target.season, target.round, target.sessionType).first();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
