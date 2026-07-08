// =========================================
// F1 Hub — functions/api/auth/me.js
// GET /api/auth/me -> { user: {...} | null }
// =========================================

import { getUserFromRequest } from '../../_lib/session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = await getUserFromRequest(request, env.F1_DB ?? null);
  return new Response(JSON.stringify({
    user: user ? {
      id: user.id, email: user.email, nickname: user.nickname, avatarUrl: user.avatar_url,
      emailVerified: Boolean(user.email_verified), isAdmin: Boolean(user.is_admin), createdAt: user.created_at,
    } : null,
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
