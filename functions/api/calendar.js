// =========================================
// F1 Hub — functions/api/calendar.js  v1.1
//
// Fuente: Jolpica-F1 (sucesor de Ergast, mismo formato)
// https://api.jolpi.ca/ergast/f1/current.json
//
// Devuelve el calendario completo de la temporada activa,
// más metadata calculada: próxima carrera, carrera en curso
// ("live window": desde 30 min antes de FP1 hasta 3h después
// de la carrera del domingo).
//
// v1.1: usa fetchResilient (reintentos + fallback a KV) porque
// Jolpica es un proyecto en alpha con caídas intermitentes
// documentadas por sus propios mantenedores. Nunca devuelve un
// error duro al frontend: si todo falla, responde 200 con
// `unavailable: true` para que la UI muestre un mensaje claro
// en vez de romperse.
// =========================================

import { fetchResilient, jsonResponse, jolpicaHeaders } from '../_lib/upstream.js';

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 900; // 15 min

export async function onRequestGet(context) {
  const { request, env } = context;
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const result = await fetchResilient(`${JOLPICA_BASE}/current.json`, {
    fetchOptions: { headers: jolpicaHeaders() },
    kv: env.F1_KV ?? null,
    staleKey: 'stale:calendar:current',
  });

  if (!result.ok) {
    // Ni el fetch en vivo ni el respaldo en KV funcionaron: avisamos
    // explícitamente en vez de devolver un 502 que rompe la UI.
    return jsonResponse({ unavailable: true, reason: 'upstream_and_backup_failed' }, 200);
  }

  const races = result.data?.MRData?.RaceTable?.Races ?? [];
  const now = new Date();
  const parsed = races.map((r) => buildRaceEntry(r));

  const upcoming = parsed.find((r) => r.race.dateTimeUTC && new Date(r.race.dateTimeUTC) > now);
  const lastCompleted = [...parsed].reverse().find((r) => r.race.dateTimeUTC && new Date(r.race.dateTimeUTC) <= now);

  let liveWeekend = null;
  for (const entry of parsed) {
    const times = entry.sessions.map((s) => s.dateTimeUTC).filter(Boolean).map((t) => new Date(t).getTime());
    if (!times.length) continue;
    const start = Math.min(...times) - 30 * 60 * 1000;
    const end = Math.max(...times) + 3 * 60 * 60 * 1000;
    if (now.getTime() >= start && now.getTime() <= end) { liveWeekend = entry; break; }
  }

  const payload = {
    unavailable: false,
    stale: result.stale,
    season: result.data?.MRData?.season ?? String(now.getFullYear()),
    updatedAt: now.toISOString(),
    races: parsed,
    nextRace: upcoming ?? null,
    lastCompletedRace: lastCompleted ?? null,
    liveWeekend,
  };

  // Si la respuesta es "stale" (viene del respaldo KV), la cacheamos
  // por mucho menos tiempo para reintentar pronto contra el upstream real.
  return jsonResponse(payload, 200, { cache, cacheKey, ttl: result.stale ? 60 : CACHE_TTL });
}

function buildRaceEntry(r) {
  const sessions = [];
  const pushSession = (key, label) => {
    const s = r[key];
    if (s?.date) {
      sessions.push({ key, label, dateTimeUTC: s.time ? `${s.date}T${s.time}` : `${s.date}T00:00:00Z` });
    }
  };
  pushSession('FirstPractice', 'Práctica 1');
  pushSession('SecondPractice', 'Práctica 2');
  pushSession('ThirdPractice', 'Práctica 3');
  pushSession('SprintQualifying', 'Clasificación Sprint');
  pushSession('Sprint', 'Sprint');
  pushSession('Qualifying', 'Clasificación');

  const raceDateTime = r.time ? `${r.date}T${r.time}` : `${r.date}T00:00:00Z`;
  sessions.push({ key: 'Race', label: 'Carrera', dateTimeUTC: raceDateTime });
  sessions.sort((a, b) => new Date(a.dateTimeUTC) - new Date(b.dateTimeUTC));

  return {
    round: Number(r.round),
    raceName: r.raceName,
    circuit: {
      id: r.Circuit?.circuitId,
      name: r.Circuit?.circuitName,
      locality: r.Circuit?.Location?.locality,
      country: r.Circuit?.Location?.country,
      lat: r.Circuit?.Location?.lat,
      long: r.Circuit?.Location?.long,
    },
    race: { date: r.date, time: r.time, dateTimeUTC: raceDateTime },
    hasSprint: Boolean(r.Sprint),
    sessions,
  };
}
