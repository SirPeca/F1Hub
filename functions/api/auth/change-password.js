// =========================================
// F1 Hub — functions/api/auth/change-password.js
// POST /api/auth/change-password { currentPassword, newPassword }
//
// Por seguridad, al cambiar la contraseña se cierran todas las demás
// sesiones activas de la cuenta (mismo criterio que reset-password) —
// si alguien más tenía acceso, esto lo saca.
// =========================================

import { verifyPassword, hashPassword } from '../../_lib/password.js';
import { getUserFromRequest, SESSION_COOKIE_NAME } from '../../_lib/session.js';
import { parseCookie } from '../../_lib/identity.js';
import { checkRateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  const user = await getUserFromRequest(request, env.F1_DB);
  if (!user) return json({ error: 'login_required' }, 401);

  const allowed = await checkRateLimit(env.F1_KV, `change-pw:${user.id}`, 5, 900);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return json({ error: 'missing_fields' }, 400);
  if (String(newPassword).length < 8) return json({ error: 'weak_password' }, 400);

  try {
    const row = await env.F1_DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    const currentOk = row?.password_hash ? await verifyPassword(currentPassword, row.password_hash) : false;
    if (!currentOk) return json({ error: 'invalid_current_password' }, 401);

    const newHash = await hashPassword(newPassword);
    const currentToken = parseCookie(request.headers.get('Cookie') || '', SESSION_COOKIE_NAME);

    await env.F1_DB.batch([
      env.F1_DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id),
      // Cerrar todas las OTRAS sesiones de esta cuenta, dejando viva la actual
      env.F1_DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, currentToken ?? ''),
    ]);

    return json({ ok: true });
  } catch {
    return json({ error: 'server_error' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
