// =========================================
// F1 Hub — functions/api/standings.js  v1
//
// GET /api/standings?type=drivers|constructors&year=2026
// year omitido = temporada actual ("current")
//
// Fuente: Jolpica-F1
// =========================================

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 600; // 10 min — durante un GP en vivo las posiciones de campeonato
                        // oficiales solo cambian al terminar la carrera, así que esto es seguro

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || 'drivers').toLowerCase();
  const yearParam = url.searchParams.get('year');
  const year = /^\d{4}$/.test(yearParam || '') ? yearParam : 'current';

  if (!['drivers', 'constructors'].includes(type)) {
    return jsonResponse({ error: 'invalid_type', message: 'type debe ser "drivers" o "constructors"' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const endpoint = type === 'drivers'
    ? `${JOLPICA_BASE}/${year}/driverStandings.json`
    : `${JOLPICA_BASE}/${year}/constructorStandings.json`;

  try {
    const res = await fetch(endpoint, { headers: { 'User-Agent': 'f1hub/1.0 (personal fan project)' } });
    if (!res.ok) return jsonResponse({ error: 'upstream_error', status: res.status }, 502);

    const data = await res.json();
    const list = data?.MRData?.StandingsTable?.StandingsLists?.[0];

    if (!list) {
      return jsonResponse({ season: year, type, standings: [], note: 'Sin datos disponibles para esta temporada todavía.' }, 200, cache, cacheKey, CACHE_TTL);
    }

    let standings;
    if (type === 'drivers') {
      standings = (list.DriverStandings || []).map((d) => ({
        position: Number(d.position),
        points: Number(d.points),
        wins: Number(d.wins),
        driverId: d.Driver?.driverId,
        code: d.Driver?.code,
        number: d.Driver?.permanentNumber,
        name: `${d.Driver?.givenName} ${d.Driver?.familyName}`,
        nationality: d.Driver?.nationality,
        constructors: (d.Constructors || []).map((c) => c.name),
      }));
    } else {
      standings = (list.ConstructorStandings || []).map((c) => ({
        position: Number(c.position),
        points: Number(c.points),
        wins: Number(c.wins),
        constructorId: c.Constructor?.constructorId,
        name: c.Constructor?.name,
        nationality: c.Constructor?.nationality,
      }));
    }

    const payload = {
      season: list.season,
      round: Number(list.round),
      type,
      standings,
    };

    return jsonResponse(payload, 200, cache, cacheKey, CACHE_TTL);
  } catch (err) {
    return jsonResponse({ error: 'fetch_failed', message: String(err) }, 500);
  }
}

function jsonResponse(obj, status = 200, cache, cacheKey, ttl) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(ttl ? { 'Cache-Control': `public, max-age=${ttl}` } : { 'Cache-Control': 'no-store' }),
    },
  });
  if (cache && cacheKey && status === 200) cache.put(cacheKey, res.clone());
  return res;
}
