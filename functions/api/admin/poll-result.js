// =========================================
// F1 Hub — functions/api/admin/poll-result.js
//
// GET  /api/admin/poll-result?pollId=5      -> detalle de votos por piloto
// POST /api/admin/poll-result { pollId, winnerDriverId } -> registra el
//      ganador real para poder calcular "% de acierto de la comunidad"
// =========================================

import { getUserFromRequest } from '../../_lib/session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  const pollId = new URL(request.url).searchParams.get('pollId');
  if (!pollId) return json({ error: 'missing_pollId' }, 400);

  const votes = await env.F1_DB.prepare(
    'SELECT driver_id, COUNT(*) as votes FROM gp_poll_votes WHERE poll_id = ? GROUP BY driver_id ORDER BY votes DESC'
  ).bind(pollId).all();

  const poll = await env.F1_DB.prepare('SELECT * FROM gp_polls WHERE id = ?').bind(pollId).first();

  return json({ poll, breakdown: votes?.results ?? [] });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { pollId, winnerDriverId } = body;
  if (!pollId || !winnerDriverId) return json({ error: 'missing_fields' }, 400);

  await env.F1_DB.prepare('UPDATE gp_polls SET winner_driver_id = ? WHERE id = ?').bind(winnerDriverId, pollId).run();
  return json({ ok: true });
}

async function requireAdmin(request, env) {
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  const user = await getUserFromRequest(request, env.F1_DB);
  if (!user || !user.is_admin) return json({ error: 'forbidden' }, 403);
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
