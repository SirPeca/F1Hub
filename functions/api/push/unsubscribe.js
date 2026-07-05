// =========================================
// F1 Hub — functions/api/push/unsubscribe.js
// POST /api/push/unsubscribe  { endpoint }
// =========================================

export async function onRequestPost(context) {
  const { request, env, data } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);
  if (!data.identityId) return json({ error: 'no_identity' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!body.endpoint) return json({ error: 'missing_endpoint' }, 400);

  // Scoped a la identidad actual: nadie puede borrar la suscripción de
  // otra persona aunque conociera (o adivinara) su endpoint.
  await env.F1_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND identity_id = ?')
    .bind(body.endpoint, data.identityId).run();
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
