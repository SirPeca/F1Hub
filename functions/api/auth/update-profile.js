// =========================================
// F1 Hub — functions/api/auth/update-profile.js
// POST /api/auth/update-profile { nickname }
// =========================================

import { getUserFromRequest } from '../../_lib/session.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  const user = await getUserFromRequest(request, env.F1_DB);
  if (!user) return json({ error: 'login_required' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const nickname = sanitizeNickname(body.nickname);
  if (!nickname) return json({ error: 'invalid_nickname' }, 400);

  try {
    await env.F1_DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, user.id).run();
    return json({ ok: true, nickname });
  } catch {
    return json({ error: 'server_error' }, 500);
  }
}

function sanitizeNickname(raw) {
  return String(raw || '').replace(/[<>]/g, '').trim().slice(0, 40);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
