// =========================================
// F1 Hub — functions/api/auth/oauth/google-callback.js
// =========================================

import { parseCookie } from '../../../_lib/identity.js';
import { createSession, sessionCookieHeader } from '../../../_lib/session.js';

export async function onRequestGet(context) {
  const { request, env, data } = context;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.F1_DB) {
    return new Response('Login con Google no está configurado.', { status: 503 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookie(request.headers.get('Cookie') || '', 'f1oauth_state');

  if (!code || !state || state !== expectedState) {
    return new Response('Estado OAuth inválido o expirado. Volvé a intentar el login.', { status: 400 });
  }

  const redirectUri = `${url.origin}/api/auth/oauth/google-callback`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return new Response('No se pudo validar el login con Google.', { status: 502 });
  const tokenData = await tokenRes.json();

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) return new Response('No se pudo leer el perfil de Google.', { status: 502 });
  const profile = await profileRes.json(); // { sub, email, name, picture, email_verified }

  const userId = await upsertOAuthUser(env.F1_DB, {
    provider: 'google', providerUserId: profile.sub, email: profile.email,
    nickname: profile.name, avatarUrl: profile.picture, emailVerified: Boolean(profile.email_verified),
  });

  if (data.identityId) {
    await env.F1_DB.prepare('UPDATE identities SET user_id = ? WHERE id = ?').bind(userId, data.identityId).run();
  }

  const { token } = await createSession(env.F1_DB, userId);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin + '/',
      'Set-Cookie': sessionCookieHeader(token),
    },
  });
}

/** Crea el usuario si es la primera vez, o lo vincula si el email ya existía con password. */
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
