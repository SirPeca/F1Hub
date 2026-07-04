// =========================================
// F1 Hub — functions/api/push/subscribe.js
// POST /api/push/subscribe  { endpoint, keys: { p256dh, auth } }
// =========================================

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  if (!data.identityId) return json({ error: 'no_identity' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return json({ error: 'invalid_subscription' }, 400);

  await env.F1_DB.prepare(`
    INSERT INTO push_subscriptions (identity_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET identity_id = excluded.identity_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).bind(data.identityId, endpoint, keys.p256dh, keys.auth).run();

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
