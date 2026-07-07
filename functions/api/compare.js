// =========================================
// F1 Hub — functions/api/compare.js  (Fase C)  v3
//
// GET /api/compare?a=hamilton&b=verstappen
//
// v3 — dos bugs reales corregidos, confirmados con evidencia (Vettel
// mostrando 0 victorias/podios/poles siendo un 4 veces campeón):
//
// 1) LA DETECCIÓN DE ERROR ERA DEMASIADO ESTRECHA. Solo marcaba "falló"
//    si el perfil Y las victorias Y las poles fallaban los tres a la
//    vez. Pero el perfil (nombre, foto) es una consulta liviana que
//    casi nunca falla, mientras que victorias/podios/poles pueden
//    fallar de forma independiente por un hipo transitorio de Jolpica
//    — y `wins ?? 0` convertía ese fallo en un cero silencioso,
//    indistinguible de "de verdad tiene cero". Ahora CUALQUIER
//    estadística que falle marca error explícito, no se disfraza de 0.
//
// 2) VELOCIDAD: se cachea el resultado completo de cada piloto por
//    separado (1 hora) en el edge cache de Cloudflare. La primera vez
//    que alguien compara a Verstappen paga el costo completo (~5
//    pedidos a Jolpica); la próxima persona que lo compare — con
//    cualquier otro piloto — lo recibe instantáneo desde caché. Como
//    la myoría de las comparaciones repiten pilotos populares, esto
//    hace que el caso común se sienta inmediato.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const DRIVER_CACHE_TTL = 3600; // 1h — las estadísticas de carrera no cambian más que una vez por finde de carrera

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
  const cache = caches.default;
  const cacheReq = new Request(`https://internal.f1hub/cache/driver-stats/${driverId}/v3`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached.json();

  const stats = await driverStats(env, driverId);

  // Solo cacheamos resultados SIN error — un fallo transitorio no debe
  // quedar pegado por una hora, tiene que poder reintentarse ya mismo.
  if (!stats.error) {
    const res = new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${DRIVER_CACHE_TTL}` } });
    cache.put(cacheReq, res.clone());
  }
  return stats;
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
