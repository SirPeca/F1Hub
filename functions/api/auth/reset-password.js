// =========================================
// F1 Hub — functions/api/auth/reset-password.js
// POST /api/auth/reset-password { token, newPassword }
// =========================================

import { hashPassword } from '../../_lib/password.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { token, newPassword } = body;
  if (!token || !newPassword) return json({ error: 'missing_fields' }, 400);
  if (newPassword.length < 8) return json({ error: 'weak_password' }, 400);

  const row = await env.F1_DB.prepare(
    'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = ?'
  ).bind(token).first();

  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
    return json({ error: 'invalid_or_expired_token' }, 400);
  }

  const passwordHash = await hashPassword(newPassword);
  await env.F1_DB.batch([
    env.F1_DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, row.user_id),
    env.F1_DB.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').bind(token),
    // Por seguridad, cerramos todas las sesiones activas de esa cuenta:
    // si alguien más tenía acceso, esto lo saca.
    env.F1_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
