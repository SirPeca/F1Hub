// =========================================
// F1 Hub — functions/_lib/session.js  v2 — "Recordarme"
//
// Sesiones de USUARIO AUTENTICADO. Distinta de la cookie de identidad
// anónima (f1id, ver _lib/identity.js): esta (f1session) solo existe
// después de un login exitoso, vive en D1 (tabla sessions) y se puede
// revocar server-side (logout real, no solo borrar la cookie).
//
// v2: dos políticas de expiración en vez de una sola. Por defecto
// (checkbox "Recordarme" sin marcar), la sesión es corta — pensada
// para equipos compartidos, como pediste. Con "Recordarme" marcado,
// dura semanas — el patrón estándar para dispositivos propios.
// =========================================

import { serializeCookie, parseCookie } from './identity.js';

const COOKIE_NAME = 'f1session';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;       // 24h absolutas sin "Recordarme"
const DEFAULT_IDLE_SECONDS = 60 * 60 * 2;        // 2h sin uso -> cierra sola
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30;  // 30 días absolutos con "Recordarme"
const REMEMBER_IDLE_SECONDS = 60 * 60 * 24 * 7;  // 7 días sin uso -> cierra sola

export async function createSession(db, userId, remember = false) {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 288 bits de entropía
  const ttl = remember ? REMEMBER_TTL_SECONDS : DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at, last_seen_at, remember) VALUES (?, ?, ?, datetime("now"), ?)')
    .bind(token, userId, expiresAt, remember ? 1 : 0).run();
  return { token, expiresAt, ttl };
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}

/** Devuelve el usuario (fila completa menos password_hash) o null si no hay sesión válida.
 * Chequea vencimiento absoluto E inactividad, con la política (corta /
 * "recordarme") que se haya elegido al loguearse. */
export async function getUserFromRequest(request, db) {
  if (!db) return null;
  const token = parseCookie(request.headers.get('Cookie') || '', COOKIE_NAME);
  if (!token) return null;

  const row = await db.prepare(`
    SELECT u.id, u.email, u.nickname, u.avatar_url, u.email_verified, u.is_admin, u.created_at,
           s.expires_at, s.last_seen_at, s.remember
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(token).first();

  if (!row) return null;

  const now = Date.now();
  const idleLimitSeconds = row.remember ? REMEMBER_IDLE_SECONDS : DEFAULT_IDLE_SECONDS;
  const expired = new Date(row.expires_at).getTime() < now;
  const idleTooLong = new Date(row.last_seen_at).getTime() + idleLimitSeconds * 1000 < now;

  if (expired || idleTooLong) {
    await destroySession(db, token); // sesión vencida (por tiempo o por inactividad): la limpiamos
    return null;
  }

  // "Tocar" la sesión no en CADA request sino solo si pasó más de 5 min
  // desde el último toque — evita una escritura de D1 por cada request
  // autenticada, y sigue siendo suficiente resolución para un idle
  // timeout de 2h/7 días.
  const lastSeenAgeMs = now - new Date(row.last_seen_at).getTime();
  if (lastSeenAgeMs > 5 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = datetime("now") WHERE id = ?').bind(token).run().catch(() => {});
  }

  delete row.expires_at;
  delete row.last_seen_at;
  delete row.remember;
  return row;
}

export function sessionCookieHeader(token, ttlSeconds = DEFAULT_TTL_SECONDS) {
  return serializeCookie(COOKIE_NAME, token, { maxAgeSeconds: ttlSeconds });
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME as SESSION_COOKIE_NAME };
