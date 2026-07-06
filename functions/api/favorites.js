// =========================================
// F1 Hub — functions/api/favorites.js  (Fase C)  v2
//
// GET  /api/favorites              -> lista de favoritos de esta identidad
// POST /api/favorites {kind,refId,label} -> toggle (agrega si no está, saca si ya está)
//
// BUG CORREGIDO: la v1 hacía "SELECT para ver si existe, después INSERT
// o DELETE según el resultado" — dos toques rápidos (doble click, doble
// tap en mobile, un reintento del navegador) podían pisarse: los dos
// pedidos veían "no existe" al mismo tiempo, y el segundo INSERT
// chocaba contra la PRIMARY KEY (identity_id, kind, ref_id) de la
// tabla, tirando una excepción sin atajar — el "El servidor tuvo un
// problema" que se veía en el sitio. Ahora usa INSERT OR IGNORE (la
// propia base de datos resuelve el choque, no una excepción de JS) y
// decide el resultado según si esa inserción realmente insertó algo.
// =========================================

import { checkRateLimit, clientIp } from '../_lib/ratelimit.js';

const VALID_KINDS = ['driver', 'constructor', 'circuit'];
const MAX_LEN = 80;

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!env.F1_DB) return json({ configured: false, favorites: [] });
  if (!data.identityId) return json({ configured: true, favorites: [] });

  try {
    const rows = await env.F1_DB.prepare(
      'SELECT kind, ref_id, label FROM favorites WHERE identity_id = ? ORDER BY created_at DESC'
    ).bind(data.identityId).all();

    return json({ configured: true, favorites: (rows?.results ?? []).map((r) => ({ kind: r.kind, refId: r.ref_id, label: r.label })) });
  } catch {
    return json({ error: 'server_error' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  if (!data.identityId) return json({ error: 'no_identity' }, 400);

  const allowed = await checkRateLimit(env.F1_KV, `favorites:${data.identityId || clientIp(request)}`, 60, 300);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const kind = String(body.kind || '');
  const refId = sanitize(body.refId);
  const label = sanitize(body.label) || refId;

  if (!VALID_KINDS.includes(kind) || !refId) return json({ error: 'invalid_fields' }, 400);

  try {
    // INSERT OR IGNORE: si ya existía, no inserta nada y no tira error —
    // la base de datos resuelve el choque, no una excepción de JS.
    const insertResult = await env.F1_DB.prepare(
      'INSERT OR IGNORE INTO favorites (identity_id, kind, ref_id, label) VALUES (?, ?, ?, ?)'
    ).bind(data.identityId, kind, refId, label).run();

    if (insertResult.meta.changes > 0) {
      return json({ favorited: true }); // no existía: se acaba de agregar
    }

    // Ya existía -> lo sacamos (esto sí puede tener un pedido "doble" que
    // borre dos veces, pero DELETE sobre algo que ya no está no tira error).
    await env.F1_DB.prepare(
      'DELETE FROM favorites WHERE identity_id = ? AND kind = ? AND ref_id = ?'
    ).bind(data.identityId, kind, refId).run();
    return json({ favorited: false });
  } catch {
    // Cualquier otro error inesperado de D1: respuesta limpia, nunca una
    // excepción sin atajar que termine en la página de error de Cloudflare.
    return json({ error: 'server_error' }, 500);
  }
}

function sanitize(raw) {
  return String(raw ?? '').replace(/[<>]/g, '').trim().slice(0, MAX_LEN);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
