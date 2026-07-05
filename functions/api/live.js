// =========================================
// F1 Hub — functions/api/live.js  v1
//
// GET /api/live
//
// Fuente: OpenF1 (https://openf1.org)
//
// IMPORTANTE — modelo de acceso de OpenF1 (2026):
//   · Datos HISTÓRICOS (sesión ya terminada hace >30 min): libres, sin auth.
//   · Datos EN VIVO (desde 30 min antes de una sesión hasta 30 min después):
//     requieren una cuenta "supporter" de pago (ver openf1.org).
//
// Esta función es honesta con esa limitación:
//   1) Siempre intenta resolver la sesión más reciente/actual.
//   2) Si el fin de semana está en curso pero OpenF1 no devuelve posiciones
//      en vivo (porque no hay key de soporte configurada), lo indica
//      explícitamente en `liveDataAvailable: false` en vez de fallar o
//      inventar datos, y el frontend cae de forma automática a mostrar
//      el cronograma de sesiones + la última clasificación oficial conocida.
//   3) Si en el futuro se agrega OPENF1_TOKEN como variable de entorno/secret
//      en Cloudflare Pages, se usará automáticamente (Bearer auth) para
//      habilitar el modo en vivo real.
// =========================================

const OPENF1_BASE = 'https://api.openf1.org/v1';
const CACHE_TTL_LIVE = 15;     // sesión en curso: refrescar seguido
const CACHE_TTL_IDLE = 300;    // sin sesión en curso: refrescar cada 5 min

export async function onRequestGet(context) {
  const { request, env } = context;
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const authHeaders = env?.OPENF1_TOKEN ? { Authorization: `Bearer ${env.OPENF1_TOKEN}` } : {};

  try {
    // 1) Resolver la sesión más reciente
    const sessionRes = await fetch(`${OPENF1_BASE}/sessions?session_key=latest`, { headers: authHeaders });
    if (!sessionRes.ok) {
      return jsonResponse({ liveDataAvailable: false, reason: 'openf1_unreachable' }, 200, cache, cacheKey, CACHE_TTL_IDLE);
    }
    const sessions = await sessionRes.json();
    const session = Array.isArray(sessions) ? sessions[0] : null;

    if (!session) {
      return jsonResponse({ liveDataAvailable: false, reason: 'no_session' }, 200, cache, cacheKey, CACHE_TTL_IDLE);
    }

    const now = Date.now();
    const start = new Date(session.date_start).getTime();
    const end = new Date(session.date_end).getTime();
    const isWithinLiveWindow = now >= start - 30 * 60 * 1000 && now <= end + 30 * 60 * 1000;

    const base = {
      session: {
        key: session.session_key,
        name: session.session_name,
        type: session.session_type,
        meetingKey: session.meeting_key,
        countryName: session.country_name,
        circuitShortName: session.circuit_short_name,
        dateStart: session.date_start,
        dateEnd: session.date_end,
      },
      isWithinLiveWindow,
    };

    if (!isWithinLiveWindow) {
      return jsonResponse({ ...base, liveDataAvailable: false, reason: 'no_active_session' }, 200, cache, cacheKey, CACHE_TTL_IDLE);
    }

    // 2) Intentar traer posiciones + pilotos + intervalos (requiere acceso en vivo)
    const [posRes, driversRes, intervalsRes, rcRes] = await Promise.all([
      fetch(`${OPENF1_BASE}/position?session_key=${session.session_key}`, { headers: authHeaders }),
      fetch(`${OPENF1_BASE}/drivers?session_key=${session.session_key}`, { headers: authHeaders }),
      fetch(`${OPENF1_BASE}/intervals?session_key=${session.session_key}`, { headers: authHeaders }),
      fetch(`${OPENF1_BASE}/race_control?session_key=${session.session_key}`, { headers: authHeaders }),
    ]);

    if (!posRes.ok) {
      // 403/451/vacío = típico cuando el modo en vivo está bloqueado sin cuenta de soporte
      return jsonResponse({ ...base, liveDataAvailable: false, reason: 'live_access_required' }, 200, cache, cacheKey, CACHE_TTL_LIVE);
    }

    const positions = await posRes.json();
    if (!Array.isArray(positions) || positions.length === 0) {
      return jsonResponse({ ...base, liveDataAvailable: false, reason: 'no_position_data' }, 200, cache, cacheKey, CACHE_TTL_LIVE);
    }

    const drivers = driversRes.ok ? await driversRes.json() : [];
    const intervals = intervalsRes.ok ? await intervalsRes.json() : [];
    const raceControl = rcRes.ok ? await rcRes.json() : [];

    // Quedarnos con el registro más reciente por piloto
    const latestByDriver = new Map();
    for (const p of positions) {
      const prev = latestByDriver.get(p.driver_number);
      if (!prev || new Date(p.date) > new Date(prev.date)) latestByDriver.set(p.driver_number, p);
    }
    const latestIntervalByDriver = new Map();
    for (const iv of intervals) {
      const prev = latestIntervalByDriver.get(iv.driver_number);
      if (!prev || new Date(iv.date) > new Date(prev.date)) latestIntervalByDriver.set(iv.driver_number, iv);
    }
    const driverInfo = new Map(drivers.map((d) => [d.driver_number, d]));

    const standings = [...latestByDriver.values()]
      .sort((a, b) => a.position - b.position)
      .map((p) => {
        const info = driverInfo.get(p.driver_number) || {};
        const iv = latestIntervalByDriver.get(p.driver_number);
        return {
          position: p.position,
          driverNumber: p.driver_number,
          code: info.name_acronym,
          fullName: info.full_name,
          team: info.team_name,
          teamColor: info.team_colour ? `#${info.team_colour}` : null,
          gapToLeader: iv?.gap_to_leader ?? null,
          intervalToAhead: iv?.interval ?? null,
        };
      });

    const flags = raceControl
      .filter((m) => m.category === 'Flag' || m.category === 'SafetyCar')
      .slice(-1)[0] || null;

    const payload = {
      ...base,
      liveDataAvailable: true,
      standings,
      lastFlag: flags ? { message: flags.message, date: flags.date } : null,
    };

    return jsonResponse(payload, 200, cache, cacheKey, CACHE_TTL_LIVE);
  } catch (err) {
    return jsonResponse({ liveDataAvailable: false, reason: 'error' }, 200, cache, cacheKey, CACHE_TTL_IDLE);
  }
}

function jsonResponse(obj, status = 200, cache, cacheKey, ttl) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
  if (cache && cacheKey) cache.put(cacheKey, res.clone());
  return res;
}
