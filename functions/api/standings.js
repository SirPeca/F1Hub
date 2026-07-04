// =========================================
// F1 Hub — functions/api/standings.js  v1.1
//
// GET /api/standings?type=drivers|constructors&year=2026
// year omitido = temporada actual ("current")
// =========================================

import { fetchResilient, jsonResponse, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 600;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || 'drivers').toLowerCase();
  const yearParam = url.searchParams.get('year');
  const year = /^\d{4}$/.test(yearParam || '') ? yearParam : 'current';

  if (!['drivers', 'constructors'].includes(type)) {
    return jsonResponse({ error: 'invalid_type', message: 'type debe ser "drivers" o "constructors"' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const endpoint = type === 'drivers'
    ? `${JOLPICA_BASE}/${year}/driverStandings.json`
    : `${JOLPICA_BASE}/${year}/constructorStandings.json`;

  const result = await fetchResilient(endpoint, {
    fetchOptions: { headers: jolpicaHeaders() },
    kv: env.F1_KV ?? null,
    staleKey: `stale:standings:${type}:${year}`,
  });

  if (!result.ok) {
    return jsonResponse({ unavailable: true, reason: 'upstream_and_backup_failed', season: year, type, standings: [] }, 200);
  }

  const list = result.data?.MRData?.StandingsTable?.StandingsLists?.[0];

  if (!list) {
    return jsonResponse(
      { unavailable: false, season: year, type, standings: [], note: 'Sin datos disponibles para esta temporada todavía.' },
      200, { cache, cacheKey, ttl: CACHE_TTL },
    );
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

  const payload = { unavailable: false, stale: result.stale, season: list.season, round: Number(list.round), type, standings };
  return jsonResponse(payload, 200, { cache, cacheKey, ttl: result.stale ? 60 : CACHE_TTL });
}
