// =========================================
// F1 Hub — functions/api/auth/register.js
//
// POST /api/auth/register  { email, password, nickname? }
//
// Nota sobre verificación de email: hasta que el proyecto tenga un
// proveedor de correo transaccional configurado (RESEND_API_KEY), las
// cuentas quedan auto-verificadas (email_verified = 1) para no romper
// el flujo de login. En cuanto exista ese secret, este archivo pasa a
// dejar email_verified = 0 y disparar el mail de verificación — el
// cambio es de una sola línea, ya está señalado abajo.
// =========================================

import { hashPassword } from '../../_lib/password.js';
import { createSession, sessionCookieHeader } from '../../_lib/session.js';
import { checkRateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured', message: 'D1 no está bindeado.' }, 503);

  const allowed = await checkRateLimit(env.F1_KV, `register:${clientIp(request)}`, 5, 3600);
  if (!allowed) return json({ error: 'rate_limited', message: 'Demasiados intentos. Probá de nuevo en un rato.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const nickname = sanitizeNickname(body.nickname) || email.split('@')[0];

  if (!isValidEmail(email)) return json({ error: 'invalid_email' }, 400);
  if (password.length < 8) return json({ error: 'weak_password', message: 'La contraseña debe tener al menos 8 caracteres.' }, 400);

  const existing = await env.F1_DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: 'email_taken' }, 409);

  const passwordHash = await hashPassword(password);

  // EMAIL_VERIFIED_DEFAULT: cambiar a 0 cuando se conecte el envío de mail real.
  const EMAIL_VERIFIED_DEFAULT = env.RESEND_API_KEY ? 0 : 1;

  const result = await env.F1_DB.prepare(
    'INSERT INTO users (email, password_hash, nickname, email_verified) VALUES (?, ?, ?, ?)'
  ).bind(email, passwordHash, nickname, EMAIL_VERIFIED_DEFAULT).run();

  const userId = result.meta.last_row_id;

  // Adoptar la identidad anónima actual: todo lo que ya votó/marcó
  // favorito como anónimo queda asociado a la cuenta nueva.
  if (data.identityId) {
    await env.F1_DB.prepare('UPDATE identities SET user_id = ? WHERE id = ?').bind(userId, data.identityId).run();
  }

  const { token, ttl } = await createSession(env.F1_DB, userId, Boolean(body.remember));

  // TODO (cuando exista RESEND_API_KEY): generar email_verification_tokens
  // y disparar el mail de verificación acá.

  return new Response(JSON.stringify({
    user: { id: userId, email, nickname, emailVerified: Boolean(EMAIL_VERIFIED_DEFAULT), isAdmin: false, createdAt: new Date().toISOString() },
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(token, ttl) },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Defensa en profundidad: el frontend ya escapa al renderizar, pero
// tampoco dejamos que caracteres de marcado lleguen a viajar hasta D1.
function sanitizeNickname(raw) {
  return String(raw || '').replace(/[<>]/g, '').trim().slice(0, 40);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
