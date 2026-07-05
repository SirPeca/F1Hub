// =========================================
// F1 Hub — functions/api/_middleware.js
//
// Se ejecuta antes de CUALQUIER función bajo /api/*. Resuelve la
// identidad anónima del visitante (cookie firmada `f1id`) y la deja
// disponible en `context.data.identityId` para que likes/votos/
// favoritos la usen sin repetir esta lógica.
//
// Si todavía no existe el binding de D1 (env.F1_DB), igual funciona:
// simplemente no persiste el registro de la identidad en la tabla
// `identities` hasta que el binding exista (degradación elegante,
// mismo criterio que usamos con KV en _lib/upstream.js).
// =========================================

import { signValue, verifyValue, parseCookie, serializeCookie } from '../_lib/identity.js';

const COOKIE_NAME = 'f1id';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 730; // ~2 años

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const secret = env.IDENTITY_SECRET || 'dev-secret-cambiar-en-produccion';

  const cookieHeader = request.headers.get('Cookie') || '';
  const existing = parseCookie(cookieHeader, COOKIE_NAME);

  let identityId = null;
  if (existing) {
    const dot = existing.lastIndexOf('.');
    if (dot > 0) {
      const id = existing.slice(0, dot);
      const sig = existing.slice(dot + 1);
      if (await verifyValue(id, sig, secret)) identityId = id;
    }
  }

  const isNew = !identityId;
  if (isNew) identityId = crypto.randomUUID();

  data.identityId = identityId;
  data.isNewIdentity = isNew;

  // IMPORTANTE: esto tiene que pasar ANTES de next(), no después. Si un
  // visitante nuevo entra directo a registrarse/loguearse, esa función
  // hace `UPDATE identities SET user_id=... WHERE id=...` — si la fila
  // todavía no existe (porque la insertamos recién al final, vía
  // waitUntil), el UPDATE no afecta ninguna fila y el favorito/voto
  // anónimo previo nunca queda vinculado a la cuenta nueva. Esperamos
  // este insert (es una sola fila, rapidísimo) antes de seguir.
  if (isNew && env.F1_DB) {
    await env.F1_DB.prepare('INSERT OR IGNORE INTO identities (id) VALUES (?)').bind(identityId).run().catch(() => {});
  }

  const response = await next();

  if (isNew) {
    const signature = await signValue(identityId, secret);
    const headers = new Headers(response.headers);
    headers.append('Set-Cookie', serializeCookie(COOKIE_NAME, `${identityId}.${signature}`, { maxAgeSeconds: MAX_AGE_SECONDS }));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  return response;
}
