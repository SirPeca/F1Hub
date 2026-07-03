// =========================================
// F1 Hub — functions/api/calendar.js  v1
//
// Fuente: Jolpica-F1 (sucesor de Ergast, mismo formato)
// https://api.jolpi.ca/ergast/f1/current.json
//
// Devuelve el calendario completo de la temporada activa,
// más metadata calculada: próxima carrera, carrera en curso
// ("live window": desde 30 min antes de FP1 hasta 3h después
// de la carrera del domingo), y el próximo evento puntual
// (sesión) dentro del fin de semana.
// =========================================

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 900; // 15 min — el calendario cambia poco, pero puede ajustarse (retrasos, etc.)

export async function onRequestGet(context) {
  const { request } = context;
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${JOLPICA_BASE}/current.json`, {
      headers: { 'User-Agent': 'f1hub/1.0 (personal fan project)' },
    });

    if (!res.ok) {
      return jsonResponse({ error: 'upstream_error', status: res.status }, 502);
    }

    const data = await res.json();
    const races = data?.MRData?.RaceTable?.Races ?? [];

    const now = new Date();
    const parsed = races.map((r) => buildRaceEntry(r));

    // Próxima carrera: primer round cuya fecha/hora de carrera es futura
    const upcoming = parsed.find((r) => r.race.dateTimeUTC && new Date(r.race.dateTimeUTC) > now);
    // Última carrera ya finalizada
    const lastCompleted = [...parsed].reverse().find((r) => r.race.dateTimeUTC && new Date(r.race.dateTimeUTC) <= now);

    // ¿Hay un fin de semana de GP "activo" ahora? (desde la primera sesión
    // del viernes hasta 3h después del final de la carrera del domingo)
    let liveWeekend = null;
    for (const entry of parsed) {
      const sessions = entry.sessions;
      const times = sessions.map((s) => s.dateTimeUTC).filter(Boolean).map((t) => new Date(t).getTime());
      if (!times.length) continue;
      const start = Math.min(...times) - 30 * 60 * 1000; // 30 min de margen antes de la primera sesión
      const end = Math.max(...times) + 3 * 60 * 60 * 1000; // 3h de margen tras la última sesión
      if (now.getTime() >= start && now.getTime() <= end) {
        liveWeekend = entry;
        break;
      }
    }

    const payload = {
      season: data?.MRData?.season ?? new Date().getFullYear().toString(),
      updatedAt: now.toISOString(),
      races: parsed,
      nextRace: upcoming ?? null,
      lastCompletedRace: lastCompleted ?? null,
      liveWeekend, // null si no hay ningún GP en curso
    };

    return jsonResponse(payload, 200, cache, cacheKey, CACHE_TTL);
  } catch (err) {
    return jsonResponse({ error: 'fetch_failed', message: String(err) }, 500);
  }
}

function buildRaceEntry(r) {
  const sessions = [];
  const pushSession = (key, label) => {
    const s = r[key];
    if (s?.date) {
      sessions.push({
        key,
        label,
        dateTimeUTC: s.time ? `${s.date}T${s.time}` : `${s.date}T00:00:00Z`,
      });
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

function jsonResponse(obj, status = 200, cache, cacheKey, ttl) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(ttl ? { 'Cache-Control': `public, max-age=${ttl}` } : { 'Cache-Control': 'no-store' }),
    },
  });
  if (cache && cacheKey && status === 200) {
    // No await: dejamos que se guarde en cache de forma async
    cache.put(cacheKey, res.clone());
  }
  return res;
}
