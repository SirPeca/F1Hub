// =========================================
// F1 Hub — functions/api/history.js  v1.1
//
// GET /api/history?mode=year&year=2023
// GET /api/history?mode=circuit&circuit=monza
// GET /api/history?mode=circuits
// =========================================

import { fetchResilient, jsonResponse, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL_PAST = 86400;   // temporadas cerradas: 24h
const CACHE_TTL_CURRENT = 900;  // temporada en curso: 15 min

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const mode = (url.searchParams.get('mode') || 'year').toLowerCase();
  const kv = env.F1_KV ?? null;

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (mode === 'year') return handleYear(url, cache, cacheKey, kv);
  if (mode === 'circuit') return handleCircuit(url, cache, cacheKey, kv);
  if (mode === 'circuits') return handleCircuitList(cache, cacheKey, kv);
  return jsonResponse({ error: 'invalid_mode' }, 400);
}

async function handleYear(url, cache, cacheKey, kv) {
  const year = url.searchParams.get('year');
  if (!/^\d{4}$/.test(year || '')) return jsonResponse({ error: 'invalid_year' }, 400);

  const currentYear = new Date().getFullYear();
  const ttl = Number(year) < currentYear ? CACHE_TTL_PAST : CACHE_TTL_CURRENT;

  const [winnersRes, driverStandRes, constructorStandRes] = await Promise.all([
    fetchResilient(`${JOLPICA_BASE}/${year}/results/1.json?limit=40`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:history:winners:${year}` }),
    fetchResilient(`${JOLPICA_BASE}/${year}/driverStandings.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:history:driverstd:${year}` }),
    fetchResilient(`${JOLPICA_BASE}/${year}/constructorStandings.json`, { fetchOptions: { headers: jolpicaHeaders() }, kv, staleKey: `stale:history:constructorstd:${year}` }),
  ]);

  if (!winnersRes.ok) {
    return jsonResponse({ unavailable: true, reason: 'upstream_and_backup_failed', year: Number(year) }, 200);
  }

  const races = winnersRes.data?.MRData?.RaceTable?.Races ?? [];
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

  const driverChampion = extractTopDriver(driverStandRes);
  const constructorChampion = extractTopConstructor(constructorStandRes);
  const anyStale = winnersRes.stale || driverStandRes.stale || constructorStandRes.stale;

  const payload = { unavailable: false, stale: anyStale, year: Number(year), rounds, driverChampion, constructorChampion };
  return jsonResponse(payload, 200, { cache, cacheKey, ttl: anyStale ? 60 : ttl });
}

function extractTopDriver(standRes) {
  if (!standRes.ok) return null;
  const top = standRes.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.[0];
  if (!top) return null;
  return {
    name: `${top.Driver?.givenName} ${top.Driver?.familyName}`,
    points: Number(top.points),
    wins: Number(top.wins),
    constructor: top.Constructors?.[0]?.name,
  };
}

function extractTopConstructor(standRes) {
  if (!standRes.ok) return null;
  const top = standRes.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings?.[0];
  if (!top) return null;
  return { name: top.Constructor?.name, points: Number(top.points), wins: Number(top.wins) };
}

async function handleCircuit(url, cache, cacheKey, kv) {
  const circuit = url.searchParams.get('circuit');
  if (!circuit) return jsonResponse({ error: 'invalid_circuit' }, 400);

  const result = await fetchResilient(`${JOLPICA_BASE}/circuits/${encodeURIComponent(circuit)}/results/1.json?limit=200`, {
    fetchOptions: { headers: jolpicaHeaders() },
    kv, staleKey: `stale:history:circuit:${circuit}`,
  });

  if (!result.ok) {
    return jsonResponse({ unavailable: true, reason: 'upstream_and_backup_failed', circuitId: circuit }, 200);
  }

  const races = result.data?.MRData?.RaceTable?.Races ?? [];
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

  const payload = { unavailable: false, stale: result.stale, circuitId: circuit, circuitName, winners };
  return jsonResponse(payload, 200, { cache, cacheKey, ttl: result.stale ? 60 : CACHE_TTL_PAST });
}

async function handleCircuitList(cache, cacheKey, kv) {
  const result = await fetchResilient(`${JOLPICA_BASE}/current.json`, {
    fetchOptions: { headers: jolpicaHeaders() },
    kv, staleKey: 'stale:history:circuitlist',
  });

  const currentCircuits = result.ok
    ? (result.data?.MRData?.RaceTable?.Races ?? []).map((r) => ({
        id: r.Circuit?.circuitId, name: r.Circuit?.circuitName, country: r.Circuit?.Location?.country,
      }))
    : [];

  // Catálogo curado de trazados históricos relevantes (no dependen del
  // upstream, así que la búsqueda "por Gran Premio" nunca queda vacía
  // aunque Jolpica esté caído).
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

  return jsonResponse({ unavailable: false, circuits }, 200, { cache, cacheKey, ttl: CACHE_TTL_PAST });
}
