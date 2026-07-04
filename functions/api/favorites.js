// =========================================
// F1 Hub — functions/api/favorites.js  (Fase C)
//
// GET  /api/favorites              -> lista de favoritos de esta identidad
// POST /api/favorites {kind,refId,label} -> toggle (agrega si no está, saca si ya está)
// =========================================

const VALID_KINDS = ['driver', 'constructor', 'circuit'];

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!env.F1_DB) return json({ configured: false, favorites: [] });
  if (!data.identityId) return json({ configured: true, favorites: [] });

  const rows = await env.F1_DB.prepare(
    'SELECT kind, ref_id, label FROM favorites WHERE identity_id = ? ORDER BY created_at DESC'
  ).bind(data.identityId).all();

  return json({ configured: true, favorites: (rows?.results ?? []).map((r) => ({ kind: r.kind, refId: r.ref_id, label: r.label })) });
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  if (!data.identityId) return json({ error: 'no_identity' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { kind, refId, label } = body;
  if (!VALID_KINDS.includes(kind) || !refId) return json({ error: 'invalid_fields' }, 400);

  const existing = await env.F1_DB.prepare(
    'SELECT 1 FROM favorites WHERE identity_id = ? AND kind = ? AND ref_id = ?'
  ).bind(data.identityId, kind, refId).first();

  if (existing) {
    await env.F1_DB.prepare(
      'DELETE FROM favorites WHERE identity_id = ? AND kind = ? AND ref_id = ?'
    ).bind(data.identityId, kind, refId).run();
    return json({ favorited: false });
  }

  await env.F1_DB.prepare(
    'INSERT INTO favorites (identity_id, kind, ref_id, label) VALUES (?, ?, ?, ?)'
  ).bind(data.identityId, kind, refId, label ?? refId).run();
  return json({ favorited: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
