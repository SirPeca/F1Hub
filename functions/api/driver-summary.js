// =========================================
// F1 Hub — functions/api/driver-summary.js  (Fase C)
//
// GET /api/driver-summary?id=hamilton
//
// Versión de un solo piloto de la misma lógica de functions/api/compare.js
// (mismo truco: limit=1 + leer MRData.total), para enriquecer la pestaña
// Favoritos con datos reales en vez de solo el nombre.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

export async function onRequestGet(context) {
  const { env } = context;
  const id = new URL(context.request.url).searchParams.get('id');
  if (!id) return json({ error: 'missing_id' }, 400);

  const kv = env.F1_KV ?? null;
  const [wins, p2, p3, poles, profile] = await Promise.all([
    total(`${JOLPICA_BASE}/drivers/${id}/results/1.json?limit=1`, kv, `stale:sum:wins:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/results/2.json?limit=1`, kv, `stale:sum:p2:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/results/3.json?limit=1`, kv, `stale:sum:p3:${id}`),
    total(`${JOLPICA_BASE}/drivers/${id}/qualifying/1.json?limit=1`, kv, `stale:sum:poles:${id}`),
    fetchResilient(`${JOLPICA_BASE}/drivers/${id}.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:sum:profile:${id}` }),
  ]);

  const info = profile.ok ? profile.data?.MRData?.DriverTable?.Drivers?.[0] : null;
  const wins_ = wins ?? 0, p2_ = p2 ?? 0, p3_ = p3 ?? 0;

  return json({
    driverId: id,
    nationality: info?.nationality ?? null,
    dateOfBirth: info?.dateOfBirth ?? null,
    wins: wins_,
    podiums: wins_ + p2_ + p3_,
    poles: poles ?? 0,
  });
}

async function total(url, kv, staleKey) {
  const result = await fetchResilient(url, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey });
  if (!result.ok) return null;
  const n = Number(result.data?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
