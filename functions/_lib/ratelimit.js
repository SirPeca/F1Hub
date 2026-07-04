// =========================================
// F1 Hub — functions/_lib/ratelimit.js
//
// Rate limiting de ventana fija sobre KV. No es lo más sofisticado
// (un token bucket sería más preciso) pero es más que suficiente para
// frenar fuerza bruta en login/registro sin agregar infraestructura.
// Si no hay KV bindeado, deja pasar todo (degradación elegante, mismo
// criterio que el resto del proyecto) — pero lo ideal es tener KV
// configurado antes de exponer /auth/* en producción.
// =========================================

/**
 * @param {KVNamespace} kv
 * @param {string} key - identificador único (ej: `login:${ip}`)
 * @param {number} limit - máximo de intentos en la ventana
 * @param {number} windowSeconds - duración de la ventana
 * @returns {Promise<boolean>} true si está permitido, false si superó el límite
 */
export async function checkRateLimit(kv, key, limit, windowSeconds) {
  if (!kv) return true;
  const fullKey = `ratelimit:${key}`;
  const current = await kv.get(fullKey);
  const count = current ? Number(current) : 0;

  if (count >= limit) return false;

  await kv.put(fullKey, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
