// =========================================
// F1 Hub — functions/_lib/session.js
//
// Sesiones de USUARIO AUTENTICADO. Distinta de la cookie de identidad
// anónima (f1id, ver _lib/identity.js): esta (f1session) solo existe
// después de un login exitoso, vive en D1 (tabla sessions) y se puede
// revocar server-side (logout real, no solo borrar la cookie).
// =========================================

import { serializeCookie, parseCookie } from './identity.js';

const COOKIE_NAME = 'f1session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días

export async function createSession(db, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 288 bits de entropía
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt).run();
  return { token, expiresAt };
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}

/** Devuelve el usuario (fila completa menos password_hash) o null si no hay sesión válida. */
export async function getUserFromRequest(request, db) {
  if (!db) return null;
  const token = parseCookie(request.headers.get('Cookie') || '', COOKIE_NAME);
  if (!token) return null;

  const row = await db.prepare(`
    SELECT u.id, u.email, u.nickname, u.avatar_url, u.email_verified, u.is_admin, u.created_at, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(token).first();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(db, token); // sesión vencida: la limpiamos
    return null;
  }
  delete row.expires_at;
  return row;
}

export function sessionCookieHeader(token) {
  return serializeCookie(COOKIE_NAME, token, { maxAgeSeconds: SESSION_TTL_SECONDS });
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME as SESSION_COOKIE_NAME };
