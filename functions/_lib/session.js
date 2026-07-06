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
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días — vencimiento absoluto, tope duro
const IDLE_TIMEOUT_SECONDS = 60 * 60 * 24 * 7; // 7 días sin uso — cierra sola aunque falte para el tope absoluto

export async function createSession(db, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 288 bits de entropía
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  // last_seen_at explícito: el default de la columna es solo una
  // constante vacía (ver migración 0005), así que cada sesión nueva
  // tiene que setearlo acá, no puede confiar en el default de la tabla.
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, datetime("now"))')
    .bind(token, userId, expiresAt).run();
  return { token, expiresAt };
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}

/** Devuelve el usuario (fila completa menos password_hash) o null si no hay sesión válida.
 * Chequea DOS cosas, no solo una: el vencimiento absoluto (30 días desde el
 * login, tope duro) y el vencimiento por INACTIVIDAD (7 días sin usar el
 * sitio) — buena práctica estándar de idle timeout para reducir el riesgo
 * de sesiones olvidadas en equipos compartidos. */
export async function getUserFromRequest(request, db) {
  if (!db) return null;
  const token = parseCookie(request.headers.get('Cookie') || '', COOKIE_NAME);
  if (!token) return null;

  const row = await db.prepare(`
    SELECT u.id, u.email, u.nickname, u.avatar_url, u.email_verified, u.is_admin, u.created_at, s.expires_at, s.last_seen_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(token).first();

  if (!row) return null;

  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() < now;
  const idleTooLong = new Date(row.last_seen_at).getTime() + IDLE_TIMEOUT_SECONDS * 1000 < now;

  if (expired || idleTooLong) {
    await destroySession(db, token); // sesión vencida (por tiempo o por inactividad): la limpiamos
    return null;
  }

  // "Tocar" la sesión no en CADA request (sería una escritura de D1 por
  // request autenticada) sino solo si pasó más de una hora desde el
  // último toque — suficiente resolución para un idle timeout de 7 días,
  // mucho más liviano en escrituras.
  const lastSeenAgeMs = now - new Date(row.last_seen_at).getTime();
  if (lastSeenAgeMs > 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = datetime("now") WHERE id = ?').bind(token).run().catch(() => {});
  }

  delete row.expires_at;
  delete row.last_seen_at;
  return row;
}

export function sessionCookieHeader(token) {
  return serializeCookie(COOKIE_NAME, token, { maxAgeSeconds: SESSION_TTL_SECONDS });
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME as SESSION_COOKIE_NAME };
