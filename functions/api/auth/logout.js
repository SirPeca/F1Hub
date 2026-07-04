// =========================================
// F1 Hub — functions/api/auth/logout.js
// POST /api/auth/logout
// =========================================

import { destroySession, clearSessionCookieHeader, SESSION_COOKIE_NAME } from '../../_lib/session.js';
import { parseCookie } from '../../_lib/identity.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = parseCookie(request.headers.get('Cookie') || '', SESSION_COOKIE_NAME);
  if (token && env.F1_DB) await destroySession(env.F1_DB, token);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookieHeader() },
  });
}
