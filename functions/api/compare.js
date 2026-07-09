// =========================================
// F1 Hub — functions/api/compare.js  (Fase C)  v4
//
// GET /api/compare?a=hamilton&b=verstappen
//
// v4 — CAMBIO DE ESTRATEGIA: en vez de depender de calcular en vivo
// cada vez (frágil ante el rate limit compartido de Jolpica), ahora se
// consulta PRIMERO un precálculo diario armado por cron-worker (grid
// actual + leyendas de alta demanda) — ver
// cron-worker/src/index.js JOB 3. El cálculo en vivo queda como
// respaldo para pilotos fuera de esa lista, con su propio caché de 1h
// + respaldo de 7 días en KV.
//
// v3 — dos bugs reales corregidos, confirmados con evidencia (Vettel
// mostrando 0 victorias/podios/poles siendo un 4 veces campeón):
//
// 1) LA DETECCIÓN DE ERROR ERA DEMASIADO ESTRECHA. Solo marcaba "falló"
//    si el perfil Y las victorias Y las poles fallaban los tres a la
//    vez. Ahora CUALQUIER estadística que falle marca error explícito,
//    no se disfraza de 0.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const DRIVER_CACHE_TTL = 3600; // 1h — las estadísticas de carrera no cambian más que una vez por finde de carrera
const FALLBACK_KV_TTL = 60 * 60 * 24 * 7; // 7 días — respaldo de largo plazo ante fallos transitorios

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');
  if (!a || !b) return json({ error: 'missing_drivers' }, 400);

  // Con el caché por piloto ya absorbiendo la carga repetida, volvemos
  // a pedir los dos pilotos en paralelo (más rápido en el caso frío).
  const [statsA, statsB] = await Promise.all([
    getCachedDriverStats(env, a),
    getCachedDriverStats(env, b),
  ]);

  return json({ a: statsA, b: statsB });
}

async function getCachedDriverStats(env, driverId) {
  const kv = env.F1_KV ?? null;

  // 1) Precálculo diario del cron-worker — la fuente más confiable,
  // no depende de que Jolpica responda bien justo ahora. Cubre el
  // grid actual + leyendas de alta demanda (ver cron-worker/src/index.js).
  const precomputed = await getPrecomputedDriverStats(kv, driverId);
  if (precomputed) return precomputed;

  // 2) Caché de 1h en el edge — por si ya lo calculamos en vivo hace poco
  // (pilotos fuera del precálculo, o el cron-worker todavía no corrió).
  const cache = caches.default;
  const cacheReq = new Request(`https://internal.f1hub/cache/driver-stats/${driverId}/v3`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached.json();

  // 3) Cálculo en vivo, con su propio respaldo de 7 días en KV ante fallos.
  const stats = await driverStats(env, driverId);

  if (!stats.error) {
    const res = new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${DRIVER_CACHE_TTL}` } });
    cache.put(cacheReq, res.clone());
    if (kv) kv.put(`stale:cmp:fullstats:${driverId}`, JSON.stringify(stats), { expirationTtl: FALLBACK_KV_TTL }).catch(() => {});
    return stats;
  }

  if (kv) {
    try {
      const raw = await kv.get(`stale:cmp:fullstats:${driverId}`);
      if (raw) return { ...JSON.parse(raw), stale: true };
    } catch { /* si también falla KV, seguimos al error normal */ }
  }
  return stats;
}

/** Lee el precálculo diario armado por cron-worker (JOB 3). Si ese
 * Worker todavía no está desplegado, o el piloto no está en la lista
 * precalculada, devuelve null (cae al cálculo en vivo) — nunca inventa. */
async function getPrecomputedDriverStats(kv, driverId) {
  if (!kv) return null;
  try {
    const raw = await kv.get('precomputed:driverstats');
    if (!raw) return null;
    const { drivers } = JSON.parse(raw);
    const entry = drivers?.[driverId];
    if (!entry) return null;
    const championships = await getPrecomputedChampionships(kv, driverId);
    return { ...entry, championships, error: null };
  } catch { return null; }
}

async function driverStats(env, driverId) {
  const kv = env.F1_KV ?? null;
  const [wins, p2, p3, poles, seasons, profile, championships] = await Promise.all([
    total(`${JOLPICA_BASE}/drivers/${driverId}/results/1.json?limit=1`, kv, `stale:cmp:wins:${driverId}`),
    total(`${JOLPICA_BASE}/drivers/${driverId}/results/2.json?limit=1`, kv, `stale:cmp:p2:${driverId}`),
    total(`${JOLPICA_BASE}/drivers/${driverId}/results/3.json?limit=1`, kv, `stale:cmp:p3:${driverId}`),
    total(`${JOLPICA_BASE}/drivers/${driverId}/qualifying/1.json?limit=1`, kv, `stale:cmp:poles:${driverId}`),
    total(`${JOLPICA_BASE}/drivers/${driverId}/seasons.json?limit=1`, kv, `stale:cmp:seasons:${driverId}`),
    fetchDriverProfile(driverId, kv),
    getPrecomputedChampionships(kv, driverId),
  ]);

  // CUALQUIERA de las cuatro estadísticas núcleo en null (no "0", sino
  // NULL = la consulta falló) dispara el estado de error — ya no hace
  // falta que fallen todas juntas. Esto es lo que atrapa el caso Vettel.
  const coreStats = { wins, p2, p3, poles };
  const failedFields = Object.entries(coreStats).filter(([, v]) => v === null).map(([k]) => k);
  const hasError = failedFields.length > 0;

  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;

  const displayName = profile
    ? `${profile.givenName} ${profile.familyName}`
    : driverId.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return {
    driverId,
    name: displayName,
    nationality: profile?.nationality ?? null,
    wins: hasError ? null : wins_,
    podiums: hasError ? null : wins_ + p2_ + p3_,
    poles: hasError ? null : (poles ?? 0),
    seasons: seasons ?? null,
    championships,
    error: hasError ? 'upstream_unavailable' : null,
  };
}

/** El nombre "bonito" del piloto es el dato más visible de toda la
 * comparación, así que además de los reintentos normales de
 * fetchResilient, si la primera pasada falla lo reintentamos una vez
 * más después de una pausa corta antes de resignarnos al formateo de
 * respaldo. */
async function fetchDriverProfile(driverId, kv) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fetchResilient(`${JOLPICA_BASE}/drivers/${driverId}.json`, {
      fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:cmp:profile:${driverId}`,
    });
    const info = result.ok ? result.data?.MRData?.DriverTable?.Drivers?.[0] : null;
    if (info) return info;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** Lee el mapa {driverId: cantidad} que arma cron-worker una vez por día.
 * Si el cron-worker todavía no está desplegado, devuelve null (no inventa
 * un número) en vez de romper la comparación. */
async function getPrecomputedChampionships(kv, driverId) {
  if (!kv) return null;
  try {
    const raw = await kv.get('precomputed:championships');
    if (!raw) return null;
    const { counts } = JSON.parse(raw);
    return counts?.[driverId] ?? 0;
  } catch { return null; }
}

async function total(url, kv, staleKey) {
  // 3 reintentos (en vez de los 2 por defecto) para las estadísticas
  // núcleo del comparador — acá la exactitud pesa más que la latencia
  // de un reintento extra, sobre todo ahora que el resultado se cachea
  // por 1h y ese costo se paga una sola vez por piloto.
  const result = await fetchResilient(url, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey, retries: 3 });
  if (!result.ok) return null;
  const n = Number(result.data?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
