// =========================================
// F1 Hub — functions/api/auth/oauth/github-callback.js
// =========================================

import { parseCookie } from '../../../_lib/identity.js';
import { createSession, sessionCookieHeader } from '../../../_lib/session.js';

export async function onRequestGet(context) {
  const { request, env, data } = context;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.F1_DB) {
    return new Response('Login con GitHub no está configurado.', { status: 503 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookie(request.headers.get('Cookie') || '', 'f1oauth_state');

  if (!code || !state || state !== expectedState) {
    return new Response('Estado OAuth inválido o expirado. Volvé a intentar el login.', { status: 400 });
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ code, client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET }),
  });
  if (!tokenRes.ok) return new Response('No se pudo validar el login con GitHub.', { status: 502 });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return new Response('GitHub no devolvió un token de acceso.', { status: 502 });

  const [profileRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'f1hub' } }),
    fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'f1hub' } }),
  ]);
  if (!profileRes.ok) return new Response('No se pudo leer el perfil de GitHub.', { status: 502 });
  const profile = await profileRes.json();
  const emails = emailsRes.ok ? await emailsRes.json() : [];
  const primaryEmail = emails.find((e) => e.primary)?.email || emails[0]?.email || null;

  const userId = await upsertOAuthUser(env.F1_DB, {
    provider: 'github', providerUserId: String(profile.id), email: primaryEmail,
    nickname: profile.login, avatarUrl: profile.avatar_url, emailVerified: true,
  });

  if (data.identityId) {
    await env.F1_DB.prepare('UPDATE identities SET user_id = ? WHERE id = ?').bind(userId, data.identityId).run();
  }

  const { token } = await createSession(env.F1_DB, userId);

  return new Response(null, {
    status: 302,
    headers: { Location: url.origin + '/', 'Set-Cookie': sessionCookieHeader(token) },
  });
}

async function upsertOAuthUser(db, { provider, providerUserId, email, nickname, avatarUrl, emailVerified }) {
  const existingOAuth = await db.prepare(
    'SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?'
  ).bind(provider, providerUserId).first();
  if (existingOAuth) return existingOAuth.user_id;

  let user = email ? await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first() : null;

  let userId;
  if (user) {
    userId = user.id;
  } else {
    const result = await db.prepare(
      'INSERT INTO users (email, nickname, avatar_url, email_verified) VALUES (?, ?, ?, ?)'
    ).bind(email ?? null, nickname ?? null, avatarUrl ?? null, emailVerified ? 1 : 0).run();
    userId = result.meta.last_row_id;
  }

  await db.prepare(
    'INSERT OR IGNORE INTO oauth_accounts (user_id, provider, provider_user_id) VALUES (?, ?, ?)'
  ).bind(userId, provider, providerUserId).run();

  return userId;
}
