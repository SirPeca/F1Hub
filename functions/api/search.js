// =========================================
// F1 Hub — functions/api/search.js  (Fase C)
//
// GET /api/search?q=hamilton
//
// Mantiene tres listas completas cacheadas (pilotos, constructores,
// circuitos — todas chicas: ~860/210/77 registros respectivamente) y
// busca por substring en memoria. Se refrescan solo 1 vez por día
// (cambian poco: unas pocas altas por temporada), así que esto nunca
// dispara una llamada a Jolpica por cada tecleo del usuario.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const LIST_CACHE_TTL = 86400; // 24h

export async function onRequestGet(context) {
  const { request, env } = context;
  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ drivers: [], constructors: [], circuits: [] });

  const [drivers, constructors, circuits] = await Promise.all([
    getCachedList(env, 'drivers', `${JOLPICA_BASE}/drivers.json?limit=1000`),
    getCachedList(env, 'constructors', `${JOLPICA_BASE}/constructors.json?limit=300`),
    getCachedList(env, 'circuits', `${JOLPICA_BASE}/circuits.json?limit=200`),
  ]);

  return json({
    drivers: filterDrivers(drivers, q).slice(0, 8),
    constructors: filterConstructors(constructors, q).slice(0, 8),
    circuits: filterCircuits(circuits, q).slice(0, 8),
  });
}

async function getCachedList(env, key, url) {
  const cache = caches.default;
  const cacheReq = new Request(`https://internal.f1hub/cache/list/${key}`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached.json();

  const result = await fetchResilient(url, {
    fetchOptions: { headers: jolpicaHeaders() },
    kv: env.F1_KV ?? null,
    staleKey: `stale:search:${key}`,
  });

  let list = [];
  if (result.ok) {
    if (key === 'drivers') list = result.data?.MRData?.DriverTable?.Drivers ?? [];
    if (key === 'constructors') list = result.data?.MRData?.ConstructorTable?.Constructors ?? [];
    if (key === 'circuits') list = result.data?.MRData?.CircuitTable?.Circuits ?? [];
  }

  const res = new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}` } });
  if (list.length) cache.put(cacheReq, res.clone());
  return list;
}

function filterDrivers(list, q) {
  return list.filter((d) => `${d.givenName} ${d.familyName}`.toLowerCase().includes(q) || d.code?.toLowerCase() === q)
    .map((d) => ({ type: 'driver', id: d.driverId, label: `${d.givenName} ${d.familyName}`, sub: d.nationality }));
}
function filterConstructors(list, q) {
  return list.filter((c) => c.name.toLowerCase().includes(q))
    .map((c) => ({ type: 'constructor', id: c.constructorId, label: c.name, sub: c.nationality }));
}
function filterCircuits(list, q) {
  return list.filter((c) => c.circuitName.toLowerCase().includes(q) || c.Location?.locality?.toLowerCase().includes(q) || c.Location?.country?.toLowerCase().includes(q))
    .map((c) => ({ type: 'circuit', id: c.circuitId, label: c.circuitName, sub: `${c.Location?.locality}, ${c.Location?.country}` }));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
