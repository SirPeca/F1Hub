// =========================================
// F1 Hub — functions/api/media.js  (Fase C)
//
// GET /api/media?q=Lewis%20Hamilton
//
// IMPORTANTE — por qué esto y no "fotos de pilotos" directo:
// las fotos oficiales de pilotos/equipos de F1 son material con
// copyright (Getty, Red Bull Content Pool, prensa acreditada, etc.).
// Publicarlas sin licencia en un sitio propio es exactamente el tipo
// de uso que NO está permitido aunque sea un proyecto de fan sin fines
// de lucro. En vez de eso, esta función usa la API de Wikipedia, que
// devuelve específicamente imágenes de Wikimedia Commons con licencia
// libre (CC BY-SA, CC0, dominio público) pensadas para reutilización,
// junto con su atribución. El resultado es visualmente equivalente
// pero legal de mostrar.
//
// Cachea agresivamente (7 días) porque estas imágenes casi no cambian.
// =========================================

const CACHE_TTL = 60 * 60 * 24 * 7;

export async function onRequestGet(context) {
  const { request } = context;
  const q = new URL(request.url).searchParams.get('q');
  if (!q) return json({ error: 'missing_query' }, 400);

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'f1hub/1.0 (personal fan project)' },
    });

    if (!res.ok) return respond({ found: false }, cache, cacheKey);

    const data = await res.json();
    const payload = {
      found: Boolean(data.thumbnail?.source),
      title: data.title,
      thumbnailUrl: data.thumbnail?.source ?? null,
      pageUrl: data.content_urls?.desktop?.page ?? null,
      attribution: data.thumbnail?.source ? 'Imagen vía Wikipedia/Wikimedia Commons' : null,
    };
    return respond(payload, cache, cacheKey);
  } catch (err) {
    return json({ found: false, error: String(err) }, 200);
  }
}

function respond(payload, cache, cacheKey) {
  const res = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
  });
  cache.put(cacheKey, res.clone());
  return res;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
