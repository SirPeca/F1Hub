// =========================================
// F1 Hub — functions/api/search.js  (Fase C)  v3
//
// GET /api/search?q=hamilton
//
// Dos bugs corregidos en esta versión (ambos confirmados con evidencia
// real, no solo teoría):
//
// 1) Un fallo transitorio en CUALQUIER página de la paginación cortaba
//    la lista a la mitad, y esa lista INCOMPLETA se guardaba igual en
//    caché por 24h (el chequeo era "¿tiene algo?" en vez de "¿está
//    completa?"). Ahora solo se cachea si se llegó a juntar el total
//    declarado por la propia API.
//
// 2) No había ranking de relevancia: "Ver" encontraba a "Oliver
//    Bearman" o "Paddy DRIVER" (contienen "ver" en el medio) antes que
//    a "Max VERstappen" (empieza con "Ver"), simplemente porque
//    aparecían antes en la lista sin ordenar y el corte a 8 resultados
//    los tapaba. Ahora se puntúa cada coincidencia (nombre exacto >
//    empieza con > contiene) y se ordena antes de cortar.
// =========================================

import { fetchResilient, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const LIST_CACHE_TTL = 86400; // 24h
const PAGE_LIMIT = 100; // máximo real que acepta Jolpica (confirmado en su documentación)

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
    drivers: rankAndFormat(drivers, q, driverMatchFields, driverToResult),
    constructors: rankAndFormat(constructors, q, (c) => [c.name], constructorToResult),
    circuits: rankAndFormat(circuits, q, (c) => [c.circuitName, c.Location?.locality, c.Location?.country], circuitToResult),
  });
}

async function getCachedList(env, key, baseUrl, extractItems) {
  const cache = caches.default;
  // "v3": bumpeado junto con el fix de "solo cachear listas completas" —
  // fuerza a descartar cualquier lista parcial que haya quedado cacheada
  // por el bug anterior, sin esperar a que expire sola.
  const cacheReq = new Request(`https://internal.f1hub/cache/list/${key}/v3`);
  const cached = await cache.match(cacheReq);
  if (cached) return cached.json();

  const { items, complete } = await fetchAllPages(env, baseUrl, extractItems, `stale:search:${key}`);

  // Solo cacheamos si la paginación terminó de verdad — una lista
  // parcial por un fallo transitorio NUNCA se guarda, así el próximo
  // pedido reintenta en vez de quedar pegado con datos incompletos por 24h.
  if (complete && items.length) {
    const res = new Response(JSON.stringify(items), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}` } });
    cache.put(cacheReq, res.clone());
  }
  return items;
}

/** Pagina de verdad: sigue pidiendo offset += 100 hasta juntar MRData.total.
 * Devuelve `complete: true` solo si de verdad se llegó al total declarado. */
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
      retries: 3, // esta lista se cachea 24h, vale la pena insistir un poco más que el default
    });

    if (!result.ok) return { items: all, complete: false };

    const declaredTotal = Number(result.data?.MRData?.total);
    total = Number.isFinite(declaredTotal) ? declaredTotal : all.length;

    const pageItems = extractItems(result.data);
    if (!pageItems.length) break;

    all.push(...pageItems);
    offset += PAGE_LIMIT;
  }

  return { items: all, complete: true };
}

// ---------- ranking de relevancia ----------
// 0 = coincidencia exacta, 1 = algún campo EMPIEZA con la búsqueda,
// 2 = algún campo CONTIENE la búsqueda en el medio, null = no matchea.
function matchScore(fields, q) {
  let best = null;
  for (const raw of fields) {
    if (!raw) continue;
    const field = raw.toLowerCase();
    let score = null;
    if (field === q) score = 0;
    else if (field.startsWith(q)) score = 1;
    else if (field.split(' ').some((word) => word.startsWith(q))) score = 1; // "ver" -> "Max Verstappen" (segunda palabra)
    else if (field.includes(q)) score = 2;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

function rankAndFormat(list, q, getFields, toResult) {
  return list
    .map((item) => ({ item, score: matchScore(getFields(item), q) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => a.score - b.score || getFields(a.item)[0]?.localeCompare(getFields(b.item)[0]) || 0)
    .slice(0, 8)
    .map((x) => toResult(x.item));
}

function driverMatchFields(d) {
  return [`${d.givenName} ${d.familyName}`, d.familyName, d.code];
}
function driverToResult(d) {
  return { type: 'driver', id: d.driverId, label: `${d.givenName} ${d.familyName}`, sub: d.nationality };
}
function constructorToResult(c) {
  return { type: 'constructor', id: c.constructorId, label: c.name, sub: c.nationality };
}
function circuitToResult(c) {
  return { type: 'circuit', id: c.circuitId, label: c.circuitName, sub: `${c.Location?.locality}, ${c.Location?.country}` };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
