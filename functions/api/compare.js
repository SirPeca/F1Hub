// =========================================
// F1 Hub — functions/api/compare.js  (Fase C)  v2
//
// GET /api/compare?a=hamilton&b=verstappen
//
// Truco de eficiencia: Ergast/Jolpica devuelve en `MRData.total` el
// conteo TOTAL de resultados que matchean el filtro, sin importar el
// `limit` pedido. Pedimos limit=1 en cada consulta (payload mínimo) y
// leemos ese total — así conseguimos "cantidad de victorias" o
// "cantidad de poles" de un piloto con una sola llamada liviana en vez
// de traer y contar cientos de resultados.
//
// v2 — reduce la ráfaga de pedidos: la v1 disparaba 12 requests
// simultáneos a Jolpica (6 por piloto × 2 pilotos), lo cual es
// suficiente para chocar contra su rate limit compartido (200-500/hora
// entre TODOS los usuarios de Cloudflare) justo en el peor momento —
// eso es lo que probablemente causaba comparaciones que volvían
// completamente vacías. Ahora los dos pilotos se piden en secuencia
// (máximo 6 simultáneos, no 12), y si de verdad fallan casi todos los
// datos de un piloto, se devuelve `error` explícito en vez de ceros
// silenciosos que parecen un bug.
//
// Importante: "campeonatos ganados" NO se calcula en esta request —
// recorrer standings de cada temporada de la carrera del piloto sería
// 30+ llamadas a Jolpica por consulta, rompiendo su rate limit. En vez
// de eso, lo precalcula una vez por día `cron-worker/` (Worker aparte
// con Cron Trigger, ver ese README) y lo deja en KV bajo la clave
// `precomputed:championships`. Si ese Worker todavía no está
// desplegado, esta función devuelve `championships: null` en vez de
// inventar un número.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');
  if (!a || !b) return json({ error: 'missing_drivers' }, 400);

  // Secuencial, no Promise.all de los dos pilotos juntos: reduce el
  // pico de requests simultáneos a Jolpica a la mitad (6 en vez de 12).
  const statsA = await driverStats(env, a);
  const statsB = await driverStats(env, b);

  return json({ a: statsA, b: statsB });
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

  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;

  // Si de verdad no conseguimos el nombre bonito (ni al reintentar),
  // mostramos el ID formateado ("max_verstappen" -> "Max Verstappen")
  // en vez del ID crudo en minúscula — nunca se ve "es un bug" aunque
  // técnicamente sea un dato de respaldo.
  const displayName = profile
    ? `${profile.givenName} ${profile.familyName}`
    : driverId.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const looksLikeTotalFailure = !profile && wins === null && poles === null;

  return {
    driverId,
    name: displayName,
    nationality: profile?.nationality ?? null,
    wins: wins_,
    podiums: wins_ + p2_ + p3_,
    poles: poles ?? 0,
    seasons: seasons ?? null,
    championships,
    error: looksLikeTotalFailure ? 'upstream_unavailable' : null,
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
  const result = await fetchResilient(url, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey });
  if (!result.ok) return null;
  const n = Number(result.data?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
