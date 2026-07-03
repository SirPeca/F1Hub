// =========================================
// F1 Hub — functions/api/history.js  v1
//
// GET /api/history?mode=year&year=2023
//    -> ganadores de cada Gran Premio de esa temporada + campeones
//
// GET /api/history?mode=circuit&circuit=monza
//    -> todos los ganadores históricos en ese circuito (todas las temporadas)
//
// GET /api/history?mode=circuits
//    -> catálogo de circuitos activos (para el selector "por Gran Premio")
//
// Fuente: Jolpica-F1
// =========================================

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 86400; // 24h — datos históricos no cambian

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const mode = (url.searchParams.get('mode') || 'year').toLowerCase();

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    if (mode === 'year') {
      return await handleYear(url, cache, cacheKey);
    }
    if (mode === 'circuit') {
      return await handleCircuit(url, cache, cacheKey);
    }
    if (mode === 'circuits') {
      return await handleCircuitList(cache, cacheKey);
    }
    return jsonResponse({ error: 'invalid_mode' }, 400);
  } catch (err) {
    return jsonResponse({ error: 'fetch_failed', message: String(err) }, 500);
  }
}

async function handleYear(url, cache, cacheKey) {
  const year = url.searchParams.get('year');
  if (!/^\d{4}$/.test(year || '')) return jsonResponse({ error: 'invalid_year' }, 400);

  const currentYear = new Date().getFullYear();
  // Temporadas pasadas son inmutables -> cache larga; la actual, cache corta
  const ttl = Number(year) < currentYear ? CACHE_TTL : 900;

  const [winnersRes, driverStandRes, constructorStandRes] = await Promise.all([
    fetch(`${JOLPICA_BASE}/${year}/results/1.json?limit=40`, { headers: ua() }),
    fetch(`${JOLPICA_BASE}/${year}/driverStandings.json`, { headers: ua() }),
    fetch(`${JOLPICA_BASE}/${year}/constructorStandings.json`, { headers: ua() }),
  ]);

  if (!winnersRes.ok) return jsonResponse({ error: 'upstream_error' }, 502);

  const winnersData = await winnersRes.json();
  const races = winnersData?.MRData?.RaceTable?.Races ?? [];

  const rounds = races.map((r) => {
    const winner = r.Results?.[0];
    return {
      round: Number(r.round),
      raceName: r.raceName,
      date: r.date,
      circuit: { id: r.Circuit?.circuitId, name: r.Circuit?.circuitName, country: r.Circuit?.Location?.country },
      winner: winner ? {
        driverId: winner.Driver?.driverId,
        name: `${winner.Driver?.givenName} ${winner.Driver?.familyName}`,
        constructor: winner.Constructor?.name,
      } : null,
    };
  });

  let driverChampion = null;
  if (driverStandRes.ok) {
    const d = await driverStandRes.json();
    const top = d?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.[0];
    if (top) {
      driverChampion = {
        name: `${top.Driver?.givenName} ${top.Driver?.familyName}`,
        points: Number(top.points),
        wins: Number(top.wins),
        constructor: top.Constructors?.[0]?.name,
      };
    }
  }

  let constructorChampion = null;
  if (constructorStandRes.ok) {
    const c = await constructorStandRes.json();
    const top = c?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings?.[0];
    if (top) {
      constructorChampion = { name: top.Constructor?.name, points: Number(top.points), wins: Number(top.wins) };
    }
  }

  const payload = { year: Number(year), rounds, driverChampion, constructorChampion };
  return jsonResponse(payload, 200, cache, cacheKey, ttl);
}

async function handleCircuit(url, cache, cacheKey) {
  const circuit = url.searchParams.get('circuit');
  if (!circuit) return jsonResponse({ error: 'invalid_circuit' }, 400);

  const res = await fetch(`${JOLPICA_BASE}/circuits/${encodeURIComponent(circuit)}/results/1.json?limit=200`, { headers: ua() });
  if (!res.ok) return jsonResponse({ error: 'upstream_error', status: res.status }, 502);

  const data = await res.json();
  const races = data?.MRData?.RaceTable?.Races ?? [];
  const circuitName = races[0]?.Circuit?.circuitName ?? circuit;

  const winners = races.map((r) => {
    const winner = r.Results?.[0];
    return {
      season: Number(r.season),
      round: Number(r.round),
      raceName: r.raceName,
      date: r.date,
      winner: winner ? {
        driverId: winner.Driver?.driverId,
        name: `${winner.Driver?.givenName} ${winner.Driver?.familyName}`,
        constructor: winner.Constructor?.name,
      } : null,
    };
  }).sort((a, b) => b.season - a.season);

  const payload = { circuitId: circuit, circuitName, winners };
  return jsonResponse(payload, 200, cache, cacheKey, CACHE_TTL);
}

async function handleCircuitList(cache, cacheKey) {
  // Circuitos del calendario actual + históricos icónicos frecuentes.
  // Ergast/Jolpica no tiene un endpoint liviano de "todos los circuitos con nombre bonito",
  // así que combinamos el calendario vigente (siempre correcto) con una lista curada
  // de trazados históricos relevantes para la búsqueda "por Gran Premio".
  const res = await fetch(`${JOLPICA_BASE}/current.json`, { headers: ua() });
  const current = res.ok ? await res.json() : null;
  const currentCircuits = (current?.MRData?.RaceTable?.Races ?? []).map((r) => ({
    id: r.Circuit?.circuitId,
    name: r.Circuit?.circuitName,
    country: r.Circuit?.Location?.country,
  }));

  const historic = [
    { id: 'nurburgring', name: 'Nürburgring', country: 'Germany' },
    { id: 'hockenheimring', name: 'Hockenheimring', country: 'Germany' },
    { id: 'estoril', name: 'Autódromo do Estoril', country: 'Portugal' },
    { id: 'brands_hatch', name: 'Brands Hatch', country: 'UK' },
    { id: 'kyalami', name: 'Kyalami', country: 'South Africa' },
    { id: 'adelaide', name: 'Adelaide Street Circuit', country: 'Australia' },
    { id: 'magny_cours', name: 'Circuit de Nevers Magny-Cours', country: 'France' },
    { id: 'indianapolis', name: 'Indianapolis Motor Speedway', country: 'USA' },
    { id: 'imola', name: 'Autodromo Enzo e Dino Ferrari (Imola)', country: 'Italy' },
    { id: 'sepang', name: 'Sepang International Circuit', country: 'Malaysia' },
    { id: 'istanbul', name: 'Istanbul Park', country: 'Turkey' },
    { id: 'portimao', name: 'Autódromo Internacional do Algarve', country: 'Portugal' },
    { id: 'mugello', name: 'Autodromo Internazionale del Mugello', country: 'Italy' },
  ];

  const byId = new Map();
  [...currentCircuits, ...historic].forEach((c) => { if (c.id) byId.set(c.id, c); });
  const circuits = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

  return jsonResponse({ circuits }, 200, cache, cacheKey, CACHE_TTL);
}

function ua() {
  return { 'User-Agent': 'f1hub/1.0 (personal fan project)' };
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
