// =========================================
// F1 Hub — functions/api/auth/forgot-password.js
// POST /api/auth/forgot-password { email }
//
// Genera siempre un token válido en D1 (si el email existe), pero el
// ENVÍO del mail depende de que exista RESEND_API_KEY. Sin ese secret,
// devolvemos `sent:false, reason:'email_not_configured'` — es
// información real, no un error, para que el frontend pueda mostrar
// "esta función no está activada todavía" en vez de fingir que se
// mandó un mail que nunca salió.
// =========================================

import { checkRateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  const allowed = await checkRateLimit(env.F1_KV, `forgot:${clientIp(request)}`, 5, 3600);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'invalid_email' }, 400);

  const user = await env.F1_DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();

  // Mismo mensaje exista o no el usuario (no filtramos qué emails están
  // registrados) — pero solo generamos/mandamos el token si existe de verdad.
  if (user) {
    const token = crypto.randomUUID() + crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
    await env.F1_DB.prepare(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(token, user.id, expiresAt).run();

    if (env.RESEND_API_KEY) {
      const resetUrl = `${new URL(request.url).origin}/?resetToken=${token}`;
      await sendResetEmail(env.RESEND_API_KEY, email, resetUrl).catch(() => {});
      return json({ sent: true });
    }
    return json({ sent: false, reason: 'email_not_configured' });
  }

  return json({ sent: false, reason: 'email_not_configured_or_unknown' });
}

async function sendResetEmail(apiKey, to, resetUrl) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'F1 Hub <no-reply@f1hub.pages.dev>',
      to,
      subject: 'Recuperar tu contraseña — F1 Hub',
      html: `<p>Alguien pidió restablecer tu contraseña en F1 Hub.</p><p><a href="${resetUrl}">Elegí una contraseña nueva</a> (válido por 1 hora).</p><p>Si no fuiste vos, ignorá este mail.</p>`,
    }),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
