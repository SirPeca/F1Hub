// =========================================
// F1 Hub — functions/api/push/unsubscribe.js
// POST /api/push/unsubscribe  { endpoint }
// =========================================

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!body.endpoint) return json({ error: 'missing_endpoint' }, 400);

  await env.F1_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
