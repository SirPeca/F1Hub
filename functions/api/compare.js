// =========================================
// F1 Hub — functions/api/compare.js  (Fase C)
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

  const [statsA, statsB] = await Promise.all([driverStats(env, a), driverStats(env, b)]);
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
    fetchResilient(`${JOLPICA_BASE}/drivers/${driverId}.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:cmp:profile:${driverId}` }),
    getPrecomputedChampionships(kv, driverId),
  ]);

  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;
  const info = profile.ok ? profile.data?.MRData?.DriverTable?.Drivers?.[0] : null;

  return {
    driverId,
    name: info ? `${info.givenName} ${info.familyName}` : driverId,
    nationality: info?.nationality ?? null,
    wins: wins_,
    podiums: wins_ + p2_ + p3_,
    poles: poles ?? 0,
    seasons: seasons ?? null,
    championships,
  };
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
