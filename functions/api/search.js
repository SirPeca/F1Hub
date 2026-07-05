// =========================================
// F1 Hub — functions/api/search.js  (Fase C)  v2 — con paginación real
//
// GET /api/search?q=hamilton
//
// BUG CORREGIDO: la v1 pedía limit=1000, pero el límite MÁXIMO real de
// Jolpica es 100 (documentado oficialmente). Con 860 pilotos en total,
// eso significaba traer solo los primeros ~100 (orden ascendente desde
// 1950) y perder silenciosamente a la mayoría de los pilotos modernos
// — incluido Hamilton. Ahora se pagina de verdad usando `offset` hasta
// completar `MRData.total`.
//
// Sigue cacheando 24h (estas listas cambian poco), así que la
// paginación extra (unas ~9 requests para pilotos, ~3 para
// constructores) se paga una vez por día, no por cada búsqueda.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const LIST_CACHE_TTL = 86400; // 24h
const PAGE_LIMIT = 100; // máximo real que acepta Jolpica

export async function onRequestGet(context) {
  const { request, env } = context;
  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ drivers: [], constructors: [], circuits: [] });

  const [drivers, constructors, circuits] = await Promise.all([
    getCachedList(env, 'drivers', `${JOLPICA_BASE}/drivers.json`, (d) => d?.MRData?.DriverTable?.Drivers ?? []),
    getCachedList(env, 'constructors', `${JOLPICA_BASE}/constructors.json`, (d) => d?.MRData?.ConstructorTable?.Constructors ?? []),
    getCachedList(env, 'circuits', `${JOLPICA_BASE}/circuits.json`, (d) => d?.MRData?.CircuitTable?.Circuits ?? []),
  ]);

  return json({
    drivers: filterDrivers(drivers, q).slice(0, 8),
    constructors: filterConstructors(constructors, q).slice(0, 8),
    circuits: filterCircuits(circuits, q).slice(0, 8),
  });
}

async function getCachedList(env, key, baseUrl, extractItems) {
  const cache = caches.default;
  const cacheReq = new Request(`https://internal.f1hub/cache/list/${key}`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached.json();

  const list = await fetchAllPages(env, baseUrl, extractItems, `stale:search:${key}`);

  const res = new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}` } });
  if (list.length) cache.put(cacheReq, res.clone());
  return list;
}

/** Pagina de verdad: sigue pidiendo offset += 100 hasta juntar MRData.total. */
async function fetchAllPages(env, baseUrl, extractItems, staleKeyPrefix) {
  let offset = 0;
  let total = Infinity;
  const all = [];

  while (offset < total) {
    const url = `${baseUrl}?limit=${PAGE_LIMIT}&offset=${offset}`;
    const result = await fetchResilient(url, {
      fetchOptions: { headers: jolpicaHeaders() },
      kv: env.F1_KV ?? null,
      staleKey: `${staleKeyPrefix}:${offset}`,
    });

    if (!result.ok) break; // nos quedamos con lo que ya juntamos hasta acá

    const declaredTotal = Number(result.data?.MRData?.total);
    total = Number.isFinite(declaredTotal) ? declaredTotal : all.length;

    const pageItems = extractItems(result.data);
    if (!pageItems.length) break; // corte de seguridad ante respuestas raras

    all.push(...pageItems);
    offset += PAGE_LIMIT;
  }

  return all;
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
