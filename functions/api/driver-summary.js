// =========================================
// F1 Hub — functions/api/driver-summary.js  (Fase C)  v3
//
// GET /api/driver-summary?id=hamilton
//
// v3 — mismo cambio de estrategia que compare.js: consulta primero el
// precálculo diario de cron-worker (JOB 3) antes de calcular en vivo.
// Esto es lo que hace confiable a Favoritos con varios pilotos a la
// vez, en vez de depender de que Jolpica responda bien 4 consultas por
// cada uno justo en el momento en que abrís la pestaña.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 3600;

export async function onRequestGet(context) {
  const { request, env } = context;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'missing_id' }, 400);

  const kv = env.F1_KV ?? null;

  // 1) Precálculo diario — la fuente más confiable.
  const precomputed = await getPrecomputedDriverStats(kv, id);
  if (precomputed) return json(precomputed);

  // 2) Caché de 1h en el edge.
  const cache = caches.default;
  const cacheReq = new Request(`https://internal.f1hub/cache/driver-summary/${id}/v2`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached;

  // 3) Cálculo en vivo (respaldo para pilotos fuera del precálculo).
  const [wins, p2, p3, poles, profile] = await Promise.all([
    total(`${JOLPICA_BASE}/drivers/${id}/results/1.json?limit=1`, kv, `stale:sum:wins:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/results/2.json?limit=1`, kv, `stale:sum:p2:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/results/3.json?limit=1`, kv, `stale:sum:p3:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/qualifying/1.json?limit=1`, kv, `stale:sum:poles:${id}`),
    fetchResilient(`${JOLPICA_BASE}/drivers/${id}.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:sum:profile:${id}` }),
  ]);

  const info = profile.ok ? profile.data?.MRData?.DriverTable?.Drivers?.[0] : null;
  const coreStats = { wins, p2, p3, poles };
  const hasError = Object.values(coreStats).some((v) => v === null);
  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;

  const payload = {
    driverId: id,
    nationality: info?.nationality ?? null,
    dateOfBirth: info?.dateOfBirth ?? null,
    wins: hasError ? null : wins_,
    podiums: hasError ? null : wins_ + p2_ + p3_,
    poles: hasError ? null : (poles ?? 0),
    error: hasError ? 'upstream_unavailable' : null,
  };

  const res = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': hasError ? 'no-store' : `public, max-age=${CACHE_TTL}` } });
  if (!hasError) cache.put(cacheReq, res.clone());
  return res;
}

async function getPrecomputedDriverStats(kv, id) {
  if (!kv) return null;
  try {
    const raw = await kv.get('precomputed:driverstats');
    if (!raw) return null;
    const { drivers } = JSON.parse(raw);
    const entry = drivers?.[id];
    if (!entry) return null;
    return {
      driverId: id, nationality: entry.nationality ?? null, dateOfBirth: null,
      wins: entry.wins, podiums: entry.podiums, poles: entry.poles, error: null,
    };
  } catch { return null; }
}

async function total(url, kv, staleKey) {
  const result = await fetchResilient(url, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey, retries: 3 });
  if (!result.ok) return null;
  const n = Number(result.data?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
