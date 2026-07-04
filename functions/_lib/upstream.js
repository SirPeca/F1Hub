// =========================================
// F1 Hub — functions/_lib/upstream.js
//
// Utilidad compartida por todas las funciones que llaman a APIs externas
// (Jolpica-F1, OpenF1). Centraliza:
//
//   1) Reintentos con backoff exponencial ante fallos transitorios
//      (Jolpica es un proyecto en alpha y admite caídas intermitentes:
//      https://github.com/theOehrly/Fast-F1/discussions/445).
//   2) Fallback a "última copia buena conocida" guardada en KV cuando
//      el upstream falla incluso después de reintentar. Esto es lo que
//      evita que el usuario vea una pantalla vacía o un error genérico
//      cuando Jolpica tiene un mal momento.
//
// El binding de KV es OPCIONAL: si el proyecto todavía no tiene un KV
// namespace configurado (ver wrangler.toml), esta utilidad simplemente
// no guarda/lee respaldo y se comporta como un fetch-con-reintentos común.
// =========================================

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 350;

/**
 * @param {string} url
 * @param {object} opts
 * @param {number} [opts.retries]
 * @param {number} [opts.backoffMs]
 * @param {object} [opts.fetchOptions] - se pasan tal cual a fetch()
 * @param {KVNamespace} [opts.kv] - binding opcional (env.F1_KV)
 * @param {string} [opts.staleKey] - clave para guardar/leer el respaldo en KV
 * @param {number} [opts.staleTtlSeconds] - cuánto vive el respaldo en KV (default 7 días)
 * @returns {Promise<{ok: boolean, data: any, stale: boolean, status: number|null}>}
 */
export async function fetchResilient(url, opts = {}) {
  const {
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    fetchOptions = {},
    kv = null,
    staleKey = null,
    staleTtlSeconds = 60 * 60 * 24 * 7,
  } = opts;

  let lastStatus = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, fetchOptions);
      lastStatus = res.status;

      if (res.ok) {
        const data = await res.json();
        if (kv && staleKey) {
          // No await: guardar el respaldo no debe demorar la respuesta al usuario
          kv.put(staleKey, JSON.stringify(data), { expirationTtl: staleTtlSeconds }).catch(() => {});
        }
        return { ok: true, data, stale: false, status: res.status };
      }

      // 429/503/502 suelen ser transitorios -> vale la pena reintentar
      if (![429, 502, 503, 504].includes(res.status) || attempt === retries) break;
    } catch {
      if (attempt === retries) break;
    }
    await sleep(backoffMs * Math.pow(2, attempt));
  }

  // Todos los intentos fallaron: buscar respaldo en KV
  if (kv && staleKey) {
    try {
      const cached = await kv.get(staleKey);
      if (cached) return { ok: true, data: JSON.parse(cached), stale: true, status: lastStatus };
    } catch { /* si KV también falla, caemos al error normal */ }
  }

  return { ok: false, data: null, stale: false, status: lastStatus };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jsonResponse(obj, status = 200, { cache, cacheKey, ttl } = {}) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(ttl ? { 'Cache-Control': `public, max-age=${ttl}` } : { 'Cache-Control': 'no-store' }),
    },
  });
  if (cache && cacheKey && status === 200) cache.put(cacheKey, res.clone());
  return res;
}

export function jolpicaHeaders() {
  return { 'User-Agent': 'f1hub/1.1 (personal fan project; +https://f1hub.pages.dev)' };
}
