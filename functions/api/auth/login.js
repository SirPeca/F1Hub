// =========================================
// F1 Hub — functions/api/auth/login.js
// POST /api/auth/login  { email, password }
// =========================================

import { verifyPassword } from '../../_lib/password.js';
import { createSession, sessionCookieHeader } from '../../_lib/session.js';
import { checkRateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  // Límite por IP para frenar fuerza bruta (no por email, para no filtrar
  // qué emails existen ni permitir bloquear la cuenta de otra persona).
  const allowed = await checkRateLimit(env.F1_KV, `login:${clientIp(request)}`, 10, 900);
  if (!allowed) return json({ error: 'rate_limited', message: 'Demasiados intentos. Probá de nuevo en unos minutos.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = await env.F1_DB.prepare(
    'SELECT id, email, password_hash, nickname, avatar_url, email_verified, is_admin FROM users WHERE email = ?'
  ).bind(email).first();

  // Mismo mensaje de error exista o no el usuario, y verificación en
  // tiempo constante-ish vía verifyPassword — evita que la respuesta
  // filtre si el email está o no registrado.
  const passwordOk = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !passwordOk) return json({ error: 'invalid_credentials' }, 401);

  if (data.identityId) {
    await env.F1_DB.prepare('UPDATE identities SET user_id = ? WHERE id = ?').bind(user.id, data.identityId).run();
  }

  const { token } = await createSession(env.F1_DB, user.id);

  return new Response(JSON.stringify({
    user: {
      id: user.id, email: user.email, nickname: user.nickname, avatarUrl: user.avatar_url,
      emailVerified: Boolean(user.email_verified), isAdmin: Boolean(user.is_admin),
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(token) } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
