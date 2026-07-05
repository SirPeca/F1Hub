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
    // Probamos español primero (audiencia del sitio) y si el resultado
    // es una página de desambiguación (o no trae foto), probamos en
    // inglés — Wikipedia en inglés tiene cobertura mucho más completa
    // y precisa para pilotos de F1 poco conocidos, y esto evita mostrar
    // el ícono genérico de desambiguación en vez de una foto real.
    const payload = (await fetchWikiSummary('es', q)) ?? (await fetchWikiSummary('en', q)) ?? { found: false };
    return respond(payload, cache, cacheKey);
  } catch (err) {
    return json({ found: false }, 200);
  }
}

/** Devuelve el payload si encontró una foto válida de un artículo real,
 * o null si no había nada usable (para que el caller pruebe otro idioma). */
async function fetchWikiSummary(lang, query) {
  const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'f1hub/1.0 (personal fan project)' },
  });
  if (!res.ok) return null;

  const data = await res.json();
  // "disambiguation" = página de desambiguación (ícono genérico, no una
  // foto de la persona) — la tratamos como "no encontrado" para poder
  // probar el otro idioma en vez de mostrar un ícono que no es él/ella.
  if (data.type === 'disambiguation' || !data.thumbnail?.source) return null;

  return {
    found: true,
    title: data.title,
    thumbnailUrl: data.thumbnail.source,
    pageUrl: data.content_urls?.desktop?.page ?? null,
    attribution: 'Imagen vía Wikipedia/Wikimedia Commons',
  };
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
