// =========================================
// F1 Hub — functions/api/likes.js  (Fase A)
//
// GET  /api/likes  -> { total, likedByYou }
// POST /api/likes  -> toggle (da o saca el like de ESTA identidad) y
//                      devuelve el estado actualizado
//
// Persistencia real en D1 (tabla site_likes), una fila por identidad
// anónima/usuario — la PRIMARY KEY sobre identity_id es justamente lo
// que impide el voto abusivo múltiple (no se puede insertar dos veces
// la misma identidad; para "sacar el like" se hace DELETE explícito).
//
// La identidad la resuelve `functions/api/_middleware.js` y llega acá
// en `context.data.identityId` — este archivo no toca cookies directo.
// =========================================

import { checkRateLimit } from '../_lib/ratelimit.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!env.F1_DB) return notConfigured();

  const total = await countLikes(env.F1_DB);
  const likedByYou = await hasLiked(env.F1_DB, data.identityId);

  return json({ total, likedByYou });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  if (!env.F1_DB) return notConfigured();

  const allowed = await checkRateLimit(env.F1_KV, `likes:${data.identityId}`, 20, 60);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  const already = await hasLiked(env.F1_DB, data.identityId);

  if (already) {
    await env.F1_DB.prepare('DELETE FROM site_likes WHERE identity_id = ?').bind(data.identityId).run();
  } else {
    // INSERT OR IGNORE: si por una race condition ya existiera la fila,
    // no rompe ni duplica.
    await env.F1_DB.prepare('INSERT OR IGNORE INTO site_likes (identity_id) VALUES (?)').bind(data.identityId).run();
  }

  const total = await countLikes(env.F1_DB);
  return json({ total, likedByYou: !already });
}

async function countLikes(db) {
  const row = await db.prepare('SELECT COUNT(*) as c FROM site_likes').first();
  return row?.c ?? 0;
}

async function hasLiked(db, identityId) {
  if (!identityId) return false;
  const row = await db.prepare('SELECT 1 FROM site_likes WHERE identity_id = ?').bind(identityId).first();
  return Boolean(row);
}

function notConfigured() {
  return json({ total: 0, likedByYou: false, configured: false,
    note: 'F1_DB (D1) todavía no está bindeado en este entorno.' });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
