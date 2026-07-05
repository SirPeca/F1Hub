// =========================================
// F1 Hub — app.js
// SPA sin frameworks: tabs, calendario, en vivo, posiciones,
// historia y noticias. Todo el fetch pasa por /api/* (funciones
// propias de Cloudflare Pages), nunca directo a APIs externas.
// =========================================

const TEAM_COLORS = {
  'Red Bull':'#3671C6','Ferrari':'#E8002D','Mercedes':'#27F4D2','McLaren':'#FF8000',
  'Aston Martin':'#229971','Alpine F1 Team':'#FF87BC','Williams':'#64C4FF',
  'RB F1 Team':'#6692FF','Racing Bulls':'#6692FF','Kick Sauber':'#52E252','Sauber':'#52E252','Haas F1 Team':'#B6BABD',
};

const state = {
  currentYear: new Date().getFullYear(),
  activeTab: 'calendario',
  countdownTimer: null,
};

// Escapa cualquier texto que venga de fuentes externas (RSS, nombres
// de pilotos vía API) o directamente del usuario (nickname, favoritos)
// antes de insertarlo en innerHTML. Sin esto, un feed RSS comprometido
// o una llamada directa a nuestra propia API (sin pasar por la UI)
// podría inyectar HTML/JS ejecutable.
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Llama a un endpoint y devuelve {ok, status, data}. Distingue
// explícitamente "no hay red" de "el servidor respondió pero no con
// JSON válido" (típicamente una excepción no controlada en el backend) —
// antes ambos casos mostraban el mismo "No se pudo conectar", lo que
// tapaba bugs reales de backend detrás de un mensaje de red.
async function safeRequest(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    return { ok: false, networkError: true, status: 0, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    return { ok: false, networkError: false, serverError: true, status: res.status, data: null };
  }
  return { ok: res.ok, networkError: false, serverError: false, status: res.status, data };
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setupTabs();
  setupStandingsControls();
  setupHistoryControls();
  setupLikeButton();
  setupSearch();
  setupAccount();
  setupCompare();
  setupPush();
  handlePasswordResetLink();
  loadCalendar();
});

state.config = {
  accounts: false, likesAndVotesAndFavorites: false, resilientCache: false,
  oauthGoogle: false, oauthGithub: false, emailRecovery: false, pushNotifications: false,
};

async function loadConfig() {
  try {
    state.config = await fetchJSON('/api/config');
  } catch { /* si falla, todo queda en false: se comporta como "nada configurado todavía" */ }

  // Ocultar (no solo deshabilitar) lo que no tiene backend detrás —
  // ver o tocar un botón muerto es peor que no verlo.
  if (!state.config.accounts) {
    document.getElementById('account-btn').hidden = true;
    document.getElementById('notify-btn').hidden = true;
  }
  if (!state.config.likesAndVotesAndFavorites) {
    document.getElementById('like-btn').hidden = true;
    document.querySelector('[data-tab="favoritos"]').hidden = true;
  }
}

// =========================================
// LIKES REALES (Fase A — persistidos en D1, ver functions/api/likes.js)
// =========================================
async function setupLikeButton() {
  const btn = document.getElementById('like-btn');
  const countEl = document.getElementById('like-count');
  const iconEl = document.getElementById('like-icon');

  try {
    const data = await fetchJSON('/api/likes');
    renderLikeState(data);
  } catch {
    countEl.textContent = '—';
  }

  btn.addEventListener('click', async () => {
    // Optimistic UI: respondemos al toque antes de esperar la red
    const wasPressed = btn.getAttribute('aria-pressed') === 'true';
    const currentCount = Number(countEl.textContent) || 0;
    renderLikeState({ likedByYou: !wasPressed, total: currentCount + (wasPressed ? -1 : 1) });

    try {
      const res = await fetch('/api/likes', { method: 'POST' });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      renderLikeState(data);
    } catch {
      renderLikeState({ likedByYou: wasPressed, total: currentCount }); // revertir si falló
    }
  });

  function renderLikeState(data) {
    btn.setAttribute('aria-pressed', String(Boolean(data.likedByYou)));
    countEl.textContent = data.total ?? '—';
    iconEl.textContent = data.likedByYou ? '🔴' : '🏁';
  }
}

function setupTabs() {
  // Listener delegado único: reemplaza TODOS los onclick="" inline que
  // usábamos antes en HTML generado dinámicamente. Esos onclick nunca
  // funcionaron en producción porque nuestro propio CSP (script-src
  // 'self', sin 'unsafe-inline') los bloquea — es intencional del lado
  // de seguridad, así que la solución correcta es esta delegación, no
  // debilitar el CSP.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const d = el.dataset;
    switch (d.action) {
      case 'reload': location.reload(); break;
      case 'retry-calendar': loadCalendar(); break;
      case 'retry-standings': loadStandings(); break;
      case 'retry-history-year': loadHistoryYear(); break;
      case 'retry-history-circuit': loadHistoryCircuit(); break;
      case 'toggle-favorite': toggleFavorite(d.kind, d.refId, d.label, el); break;
      case 'remove-favorite-row':
        toggleFavorite(d.kind, d.refId, d.label, el);
        el.closest('.favorite-row')?.remove();
        break;
      case 'select-compare-driver': selectCompareDriver(d.side, d.id, d.label); break;
      case 'search-result-click': onSearchResultClick(d.type, d.id); break;
      case 'vote-poll': votePoll(Number(d.pollId), d.driverId); break;
    }
  });

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((btn, i) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); tabs[(i + 1) % tabs.length].focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); tabs[(i - 1 + tabs.length) % tabs.length].focus(); }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['search-overlay', 'account-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.hidden) el.hidden = true;
    });
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));

  if (tab === 'vivo') loadLive();
  if (tab === 'posiciones') loadStandings();
  if (tab === 'historia') loadHistoryYear();
  if (tab === 'noticias') loadNews();
  if (tab === 'favoritos') loadFavorites();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function teamColor(name) {
  return TEAM_COLORS[name] || '#8a8a92';
}

function fmtDate(iso, opts = {}) {
  try {
    return new Date(iso).toLocaleDateString('es-AR', {
      day: '2-digit', month: 'short', ...opts,
    });
  } catch { return ''; }
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// =========================================
// CALENDARIO
// =========================================
let calendarData = null;

async function loadCalendar() {
  const heroEl = document.getElementById('next-race-card');
  const listEl = document.getElementById('calendar-list');
  try {
    calendarData = await fetchJSON('/api/calendar');

    if (calendarData.unavailable) {
      renderUnavailable(heroEl, listEl, 'calendario');
      return;
    }

    document.getElementById('season-label').textContent = `Temporada ${calendarData.season}`;
    renderHero();
    renderCalendarList();
    updateHeaderStatus();
    loadPoll();
    if (calendarData.stale) showStaleBanner(heroEl);
  } catch (err) {
    renderUnavailable(heroEl, listEl, 'calendario');
  }
}

// Estado "el proveedor de datos está caído y no hay respaldo": nunca
// dejamos la pantalla en blanco, siempre con una acción clara (reintentar).
function renderUnavailable(heroEl, secondaryEl, label) {
  heroEl.classList.remove('skeleton');
  heroEl.innerHTML = `
    <div class="hero-eyebrow"><span class="dot"></span>SERVICIO NO DISPONIBLE</div>
    <div class="hero-title">No pudimos traer el ${label} en este momento</div>
    <div class="hero-meta">No pudimos traer la información en este momento. Esto no depende de tu conexión — reintentá en unos minutos.</div>
    <button class="retry-btn" data-action="reload">Reintentar</button>
  `;
  if (secondaryEl) { secondaryEl.classList.remove('skeleton-block'); secondaryEl.innerHTML = ''; }
}

function showStaleBanner(container) {
  const badge = document.createElement('div');
  badge.className = 'stale-banner';
  badge.textContent = '⚠️ Mostrando la última información guardada — actualizando en segundo plano.';
  container.prepend(badge);
}

function renderHero() {
  const heroEl = document.getElementById('next-race-card');
  heroEl.classList.remove('skeleton');

  const live = calendarData.liveWeekend;
  const target = live || calendarData.nextRace;

  if (!target) {
    heroEl.innerHTML = `<div class="hero-eyebrow"><span class="dot"></span>TEMPORADA FINALIZADA</div>
      <div class="hero-title">Nos vemos la próxima temporada 🏁</div>`;
    return;
  }

  const isLive = Boolean(live);
  const raceTime = new Date(target.race.dateTimeUTC);

  heroEl.innerHTML = `
    <div class="hero-eyebrow ${isLive ? 'pulsing' : ''}"><span class="dot"></span>${isLive ? 'FIN DE SEMANA EN CURSO' : 'PRÓXIMA CARRERA'}</div>
    <div class="hero-title">${target.raceName}</div>
    <div class="hero-meta">${target.circuit.name} · ${target.circuit.locality}, ${target.circuit.country}</div>
    ${isLive ? '' : `<div class="hero-countdown" id="countdown"></div>`}
    <div class="hero-sessions">
      ${target.sessions.map((s) => sessionRow(s)).join('')}
    </div>
  `;

  if (!isLive) startCountdown(raceTime);
}

function sessionRow(s) {
  const now = Date.now();
  const t = new Date(s.dateTimeUTC).getTime();
  const isPast = t < now;
  const isRace = s.key === 'Race';
  return `<div class="hero-session-row ${isRace ? 'is-race' : ''}" style="${isPast ? 'opacity:.4' : ''}">
    <span class="s-name">${s.label}</span>
    <span class="s-time">${fmtDate(s.dateTimeUTC, { weekday: 'short' })} · ${fmtTime(s.dateTimeUTC)}</span>
  </div>`;
}

function startCountdown(target) {
  const el = document.getElementById('countdown');
  if (!el) return;
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  const tick = () => {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) { clearInterval(state.countdownTimer); loadCalendar(); return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.innerHTML = [
      [d, 'DÍAS'], [h, 'HS'], [m, 'MIN'], [s, 'SEG'],
    ].map(([v, l]) => `<div class="cd-unit"><div class="cd-num">${String(v).padStart(2, '0')}</div><div class="cd-label">${l}</div></div>`).join('');
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function renderCalendarList() {
  const listEl = document.getElementById('calendar-list');
  listEl.classList.remove('skeleton-block');
  const now = Date.now();
  const liveRound = calendarData.liveWeekend?.round;
  const nextRound = calendarData.nextRace?.round;

  listEl.innerHTML = calendarData.races.map((r) => {
    const raceTime = new Date(r.race.dateTimeUTC).getTime();
    const isDone = raceTime < now && r.round !== liveRound;
    const isLive = r.round === liveRound;
    const isNext = r.round === nextRound && !isLive;
    return `<div class="race-row ${isDone ? 'is-done' : ''} ${isLive ? 'is-live' : ''}">
      <span class="race-round">${String(r.round).padStart(2, '0')}</span>
      <div class="race-info">
        <div class="race-name">${r.raceName}</div>
        <div class="race-place">${r.circuit.locality}, ${r.circuit.country}</div>
      </div>
      ${isLive ? '<span class="race-badge live">EN VIVO</span>' : ''}
      ${isNext ? '<span class="race-badge next">PRÓXIMA</span>' : ''}
      ${r.hasSprint && !isLive && !isNext ? '<span class="race-badge sprint">SPRINT</span>' : ''}
      <span class="race-date">${fmtDate(r.race.dateTimeUTC)}</span>
    </div>`;
  }).join('');
}

function updateHeaderStatus() {
  const el = document.getElementById('header-status');
  if (calendarData.liveWeekend) {
    el.textContent = '🔴 GP en curso';
  } else if (calendarData.nextRace) {
    el.textContent = `Próx: ${calendarData.nextRace.raceName.replace('Grand Prix', 'GP')}`;
  }
}

// =========================================
// EN VIVO
// =========================================
let liveTimer = null;

async function loadLive() {
  const statusEl = document.getElementById('live-status-card');
  const contentEl = document.getElementById('live-content');
  clearInterval(liveTimer);

  try {
    const data = await fetchJSON('/api/live');
    renderLive(data, statusEl, contentEl);

    // Si hay una ventana activa, refrescamos solos cada 20s mientras la pestaña esté abierta
    if (data.isWithinLiveWindow) {
      liveTimer = setInterval(async () => {
        if (state.activeTab !== 'vivo') { clearInterval(liveTimer); return; }
        try {
          const fresh = await fetchJSON('/api/live');
          renderLive(fresh, statusEl, contentEl);
        } catch { /* silencioso, reintenta en el próximo tick */ }
      }, 20000);
    }
  } catch (err) {
    statusEl.classList.remove('skeleton');
    statusEl.innerHTML = `<div class="hero-eyebrow"><span class="dot"></span>ERROR</div><div class="hero-title">No se pudo conectar con OpenF1</div>`;
    contentEl.innerHTML = '';
  }
}

function renderLive(data, statusEl, contentEl) {
  statusEl.classList.remove('skeleton');

  if (!data.session) {
    statusEl.innerHTML = `<div class="hero-eyebrow"><span class="dot"></span>SIN SESIÓN</div><div class="hero-title">No hay ninguna sesión reciente</div>`;
    contentEl.innerHTML = '';
    return;
  }

  const { session } = data;
  const pulsing = data.isWithinLiveWindow ? 'pulsing' : '';

  statusEl.innerHTML = `
    <div class="hero-eyebrow ${pulsing}"><span class="dot"></span>${data.isWithinLiveWindow ? 'SESIÓN EN CURSO' : 'ÚLTIMA SESIÓN'}</div>
    <div class="hero-title">${session.name}</div>
    <div class="hero-meta">${session.circuitShortName || session.countryName} · ${fmtDate(session.dateStart)} · ${fmtTime(session.dateStart)}</div>
  `;

  if (!data.liveDataAvailable) {
    let reasonText = 'Todavía no hay datos de posiciones disponibles para esta sesión.';
    if (data.reason === 'live_access_required' || (data.isWithinLiveWindow && data.reason)) {
      reasonText = 'El seguimiento minuto a minuto (posiciones, gaps, banderas) requiere una cuenta de datos en vivo de OpenF1, que es un servicio de pago. Este panel se actualiza automáticamente en cuanto haya datos disponibles.';
    } else if (!data.isWithinLiveWindow) {
      reasonText = 'No hay ningún fin de semana de Gran Premio en curso ahora mismo. Mirá la pestaña <b>Calendario</b> para ver la próxima carrera.';
    }
    contentEl.innerHTML = `<div class="live-empty">${reasonText}</div>`;
    return;
  }

  contentEl.innerHTML = `
    ${data.lastFlag ? `<div class="flag-banner">🚩 ${data.lastFlag.message}</div>` : ''}
    <div class="standings-table" style="margin-top:16px">
      ${data.standings.map((d) => `
        <div class="st-row ${d.position <= 3 ? 'top3' : ''}">
          <span class="st-pos">${d.position}</span>
          <div class="st-main">
            <div class="st-name">${d.fullName || d.code || ('#' + d.driverNumber)}</div>
            <div class="st-sub"><span class="team-dot" style="background:${d.teamColor || teamColor(d.team)}"></span>${d.team || ''}</div>
          </div>
          <div>
            <span class="st-points">${d.gapToLeader ?? '—'}</span>
            <span class="st-wins">int: ${d.intervalToAhead ?? '—'}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// =========================================
// POSICIONES
// =========================================
function setupStandingsControls() {
  document.querySelectorAll('[data-standings]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-standings]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadStandings();
    });
  });

  const yearSel = document.getElementById('standings-year');
  populateYearSelect(yearSel, 1950, state.currentYear, state.currentYear);
  yearSel.addEventListener('change', loadStandings);
}

function populateYearSelect(sel, min, max, def) {
  if (sel.children.length) return;
  const opts = [];
  for (let y = max; y >= min; y--) opts.push(`<option value="${y}" ${y === def ? 'selected' : ''}>${y}</option>`);
  sel.innerHTML = opts.join('');
}

async function loadStandings() {
  const type = document.querySelector('[data-standings].active').dataset.standings;
  const year = document.getElementById('standings-year').value;
  const el = document.getElementById('standings-table');
  el.classList.add('skeleton-block');
  el.textContent = 'Cargando…';

  try {
    const data = await fetchJSON(`/api/standings?type=${type}&year=${year}`);
    el.classList.remove('skeleton-block');

    if (data.unavailable) {
      el.innerHTML = `<div class="live-empty">No pudimos traer la información en este momento. <button class="retry-btn-inline" data-action="retry-standings">Reintentar</button></div>`;
      return;
    }
    if (!data.standings.length) {
      el.innerHTML = `<div class="live-empty">${data.note || 'Sin datos para esta temporada.'}</div>`;
      return;
    }
    const staleNote = data.stale ? `<div class="stale-banner">⚠️ Datos guardados — actualizando en segundo plano.</div>` : '';
    el.innerHTML = staleNote + data.standings.map((s) => {
      if (type === 'drivers') {
        return `<div class="st-row ${s.position <= 3 ? 'top3' : ''}">
          <span class="st-pos">${s.position}</span>
          <div class="st-main">
            <div class="st-name">${s.name}</div>
            <div class="st-sub"><span class="team-dot" style="background:${teamColor(s.constructors[0])}"></span>${s.constructors.join(' / ')}</div>
          </div>
          <div><span class="st-points">${s.points}</span><span class="st-wins">${s.wins} victorias</span></div>
          ${favStarHtml('driver', s.driverId, s.name)}
        </div>`;
      }
      return `<div class="st-row ${s.position <= 3 ? 'top3' : ''}">
        <span class="st-pos">${s.position}</span>
        <div class="st-main">
          <div class="st-name"><span class="team-dot" style="background:${teamColor(s.name)};display:inline-block;margin-right:6px"></span>${s.name}</div>
        </div>
        <div><span class="st-points">${s.points}</span><span class="st-wins">${s.wins} victorias</span></div>
        ${favStarHtml('constructor', s.constructorId, s.name)}
      </div>`;
    }).join('');
  } catch {
    el.classList.remove('skeleton-block');
    el.innerHTML = `<div class="live-empty">No se pudo cargar la tabla. Reintentá más tarde.</div>`;
  }
}

// =========================================
// HISTORIA
// =========================================
function setupHistoryControls() {
  document.querySelectorAll('[data-history]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-history]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.history;
      document.getElementById('history-year-controls').hidden = mode !== 'year';
      document.getElementById('history-circuit-controls').hidden = mode !== 'circuit';
      mode === 'year' ? loadHistoryYear() : loadHistoryCircuit();
    });
  });

  const yearSel = document.getElementById('history-year');
  populateYearSelect(yearSel, 1950, state.currentYear, state.currentYear - 1);
  yearSel.addEventListener('change', loadHistoryYear);

  const circuitSel = document.getElementById('history-circuit');
  circuitSel.addEventListener('change', loadHistoryCircuit);
  loadCircuitOptions();
}

async function loadCircuitOptions() {
  const sel = document.getElementById('history-circuit');
  try {
    const data = await fetchJSON('/api/history?mode=circuits');
    sel.innerHTML = data.circuits.map((c) => `<option value="${c.id}">${c.name} (${c.country})</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">No se pudo cargar la lista</option>';
  }
}

async function loadHistoryYear() {
  const year = document.getElementById('history-year').value;
  const el = document.getElementById('history-content');
  el.classList.add('skeleton-block');
  el.textContent = 'Cargando…';

  try {
    const data = await fetchJSON(`/api/history?mode=year&year=${year}`);
    el.classList.remove('skeleton-block');

    if (data.unavailable) {
      el.innerHTML = `<div class="live-empty">No pudimos traer la información en este momento. <button class="retry-btn-inline" data-action="retry-history-year">Reintentar</button></div>`;
      return;
    }

    const staleNote = data.stale ? `<div class="stale-banner">⚠️ Datos guardados — actualizando en segundo plano.</div>` : '';
    el.innerHTML = staleNote + `
      <div class="champ-cards">
        <div class="champ-card">
          <div class="champ-label">Campeón pilotos</div>
          <div class="champ-name">${data.driverChampion?.name ?? '—'}</div>
          <div class="champ-meta">${data.driverChampion ? `${data.driverChampion.points} pts · ${data.driverChampion.wins} victorias` : ''}</div>
        </div>
        <div class="champ-card">
          <div class="champ-label">Campeón constructores</div>
          <div class="champ-name">${data.constructorChampion?.name ?? '—'}</div>
          <div class="champ-meta">${data.constructorChampion ? `${data.constructorChampion.points} pts` : ''}</div>
        </div>
      </div>
      ${data.rounds.map((r) => `
        <div class="history-round-row">
          <div class="hr-left">
            <div class="hr-race">${r.round}. ${r.raceName}</div>
            <div class="hr-date">${fmtDate(r.date, { year: 'numeric' })}</div>
          </div>
          <div class="hr-winner">${r.winner ? r.winner.name : '—'}</div>
        </div>
      `).join('')}
    `;
  } catch {
    el.classList.remove('skeleton-block');
    el.innerHTML = `<div class="live-empty">No se pudo cargar la temporada ${year}.</div>`;
  }
}

async function loadHistoryCircuit() {
  const circuit = document.getElementById('history-circuit').value;
  if (!circuit) return;
  const el = document.getElementById('history-content');
  el.classList.add('skeleton-block');
  el.textContent = 'Cargando…';

  try {
    const data = await fetchJSON(`/api/history?mode=circuit&circuit=${circuit}`);
    el.classList.remove('skeleton-block');

    if (data.unavailable) {
      el.innerHTML = `<div class="live-empty">No pudimos traer la información en este momento. <button class="retry-btn-inline" data-action="retry-history-circuit">Reintentar</button></div>`;
      return;
    }
    if (!data.winners.length) {
      el.innerHTML = `<div class="live-empty">Sin datos históricos para este circuito.</div>`;
      return;
    }
    el.innerHTML = `<h3 class="section-title" style="margin-top:0">${data.circuitName} ${favStarHtml('circuit', circuit, data.circuitName)}</h3>` +
      data.winners.map((w) => `
        <div class="circuit-winner-row">
          <span class="cw-year">${w.season}</span>
          <span class="cw-name">${w.winner ? w.winner.name : '—'}</span>
        </div>
      `).join('');
  } catch {
    el.classList.remove('skeleton-block');
    el.innerHTML = `<div class="live-empty">No se pudo cargar el historial de este circuito.</div>`;
  }
}

// =========================================
// NOTICIAS
// =========================================
async function loadNews() {
  const chipsEl = document.getElementById('news-sources');
  const listEl = document.getElementById('news-list');
  try {
    const data = await fetchJSON('/api/news');
    chipsEl.innerHTML = Object.entries(data.sourceStatus).map(([src, status]) =>
      `<span class="news-source-chip ${status}">${src}${status !== 'ok' ? ' · sin conexión' : ''}</span>`
    ).join('');

    listEl.classList.remove('skeleton-block');
    if (!data.items.length) {
      listEl.innerHTML = `<div class="live-empty">No se pudieron cargar noticias en este momento.</div>`;
      return;
    }
    listEl.innerHTML = data.items.map((n) => `
      <a class="news-item" href="${n.link}" target="_blank" rel="noopener noreferrer">
        <div class="news-meta"><span>${esc(n.source)}</span><span>${fmtDate(n.pubDate)} · ${fmtTime(n.pubDate)}</span></div>
        <div class="news-title">${esc(n.title)}</div>
        ${n.summary ? `<div class="news-summary">${esc(n.summary)}</div>` : ''}
      </a>
    `).join('');
  } catch {
    listEl.classList.remove('skeleton-block');
    listEl.innerHTML = `<div class="live-empty">No se pudieron cargar noticias en este momento.</div>`;
  }
}

// ---------- Service worker opcional (offline shell) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });

  // Si un SW nuevo toma control (después de un deploy), recargamos una
  // sola vez para asegurarnos de que el HTML/JS en pantalla sea el
  // nuevo — evita el bug de "quedar pegado" en una versión vieja.
  let reloadedOnce = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedOnce) return;
    reloadedOnce = true;
    window.location.reload();
  });
}

// =========================================
// FAVORITOS (Fase C)
// =========================================
state.favoriteKeys = new Set();

async function loadFavoriteKeys() {
  try {
    const data = await fetchJSON('/api/favorites');
    state.favoriteKeys = new Set((data.favorites || []).map((f) => `${f.kind}:${f.refId}`));
  } catch { /* si falla, simplemente no se muestran estrellas marcadas */ }
}

function favStarHtml(kind, refId, label) {
  if (!refId || !state.config.likesAndVotesAndFavorites) return '';
  const isFav = state.favoriteKeys.has(`${kind}:${refId}`);
  return `<button class="favorite-star ${isFav ? 'is-fav' : ''}" aria-label="Favorito"
    data-action="toggle-favorite" data-kind="${esc(kind)}" data-ref-id="${esc(refId)}" data-label="${esc(label)}">★</button>`;
}

async function toggleFavorite(kind, refId, label, btnEl) {
  const willBeFav = !btnEl.classList.contains('is-fav');
  btnEl.classList.toggle('is-fav'); // optimista
  btnEl.disabled = true;

  const { ok, networkError, serverError, data } = await safeRequest('/api/favorites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, refId, label }),
  });
  btnEl.disabled = false;

  if (networkError) { btnEl.classList.toggle('is-fav'); toast('No hay conexión. Revisá tu internet.'); return; }
  if (serverError) { btnEl.classList.toggle('is-fav'); toast('El servidor tuvo un problema. Probá de nuevo.'); return; }
  if (!ok) {
    btnEl.classList.toggle('is-fav');
    toast(data?.error === 'not_configured' ? 'Esta función estará disponible próximamente.' : 'No se pudo guardar. Probá de nuevo.');
    return;
  }

  const key = `${kind}:${refId}`;
  if (data.favorited) state.favoriteKeys.add(key); else state.favoriteKeys.delete(key);
  btnEl.classList.toggle('is-fav', Boolean(data.favorited));
  toast(data.favorited ? `${label} agregado a favoritos ⭐` : `${label} sacado de favoritos`);
}

// Aviso corto y no intrusivo para errores que antes fallaban en silencio.
let toastTimer = null;
function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

async function loadFavorites() {
  const el = document.getElementById('favorites-list');
  if (!state.config.likesAndVotesAndFavorites) {
    el.classList.remove('skeleton-block');
    el.innerHTML = `<div class="live-empty">Esta función estará disponible próximamente.</div>`;
    return;
  }
  el.classList.add('skeleton-block');
  try {
    const data = await fetchJSON('/api/favorites');
    el.classList.remove('skeleton-block');
    const favs = data.favorites || [];
    if (!favs.length) { el.innerHTML = ''; return; }

    const groups = { driver: 'Pilotos', constructor: 'Equipos', circuit: 'Circuitos' };
    el.innerHTML = Object.entries(groups).map(([kind, title]) => {
      const items = favs.filter((f) => f.kind === kind);
      if (!items.length) return '';
      return `<div class="favorites-group-title">${title}</div>` + items.map((f) => `
        <div class="favorite-row">
          <span>${esc(f.label)}</span>
          <button class="favorite-star is-fav" data-action="remove-favorite-row" data-kind="${esc(f.kind)}" data-ref-id="${esc(f.refId)}" data-label="${esc(f.label)}">★</button>
        </div>
      `).join('');
    }).join('');
  } catch {
    el.classList.remove('skeleton-block');
    el.innerHTML = `<div class="live-empty">No se pudieron cargar los favoritos.</div>`;
  }
}

// =========================================
// COMPARADOR (Fase C)
// =========================================
const compareSelection = { a: null, b: null };

function setupCompare() {
  wireCompareInput('a');
  wireCompareInput('b');
}

function wireCompareInput(side) {
  const input = document.getElementById(`compare-${side}`);
  const resultsEl = document.getElementById(`compare-${side}-results`);
  let debounce;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    compareSelection[side] = null;
    if (q.length < 2) { resultsEl.hidden = true; return; }
    debounce = setTimeout(async () => {
      try {
        const data = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}`);
        const drivers = data.drivers || [];
        resultsEl.hidden = drivers.length === 0;
        resultsEl.innerHTML = drivers.map((d) =>
          `<div class="autocomplete-item" data-action="select-compare-driver" data-side="${esc(side)}" data-id="${esc(d.id)}" data-label="${esc(d.label)}">${esc(d.label)}</div>`
        ).join('');
      } catch { resultsEl.hidden = true; }
    }, 250);
  });
}

function selectCompareDriver(side, id, label) {
  compareSelection[side] = id;
  document.getElementById(`compare-${side}`).value = label;
  document.getElementById(`compare-${side}-results`).hidden = true;
  if (compareSelection.a && compareSelection.b) runCompare();
}

async function runCompare() {
  const el = document.getElementById('compare-result');
  el.innerHTML = '<div class="skeleton-block">Comparando…</div>';
  try {
    const [data, mediaA, mediaB] = await Promise.all([
      fetchJSON(`/api/compare?a=${compareSelection.a}&b=${compareSelection.b}`),
      fetchJSON(`/api/media?q=${encodeURIComponent(document.getElementById('compare-a').value)}`).catch(() => ({ found: false })),
      fetchJSON(`/api/media?q=${encodeURIComponent(document.getElementById('compare-b').value)}`).catch(() => ({ found: false })),
    ]);
    const rows = [
      ['championships', 'Campeonatos'], ['wins', 'Victorias'], ['podiums', 'Podios'], ['poles', 'Poles'], ['seasons', 'Temporadas'],
    ];
    el.innerHTML = `
      <div class="compare-header">
        <span class="ch-name">${mediaA.found ? `<img class="ch-photo" loading="lazy" src="${mediaA.thumbnailUrl}" alt="${data.a.name}">` : ''}${data.a.name}</span>
        <span class="ch-name">${data.b.name}${mediaB.found ? `<img class="ch-photo" loading="lazy" src="${mediaB.thumbnailUrl}" alt="${data.b.name}">` : ''}</span>
      </div>
      ${rows.map(([key, label]) => {
        const av = data.a[key] ?? '—', bv = data.b[key] ?? '—';
        const aWin = typeof av === 'number' && typeof bv === 'number' && av > bv;
        const bWin = typeof av === 'number' && typeof bv === 'number' && bv > av;
        return `<div class="compare-stat-row">
          <div class="compare-stat-val ${aWin ? 'win' : ''}" style="text-align:left">${av}</div>
          <div class="compare-stat-label">${label}</div>
          <div class="compare-stat-val ${bWin ? 'win' : ''}" style="text-align:right">${bv}</div>
        </div>`;
      }).join('')}
      <p class="favorites-hint">${data.a.championships === null || data.b.championships === null ? 'Campeonatos: se calculan con un proceso diario aparte — todavía no corrió por primera vez.' : ''} ${mediaA.found || mediaB.found ? 'Fotos vía Wikipedia/Wikimedia Commons.' : ''}</p>
    `;
  } catch {
    el.innerHTML = `<div class="live-empty">No se pudo comparar en este momento.</div>`;
  }
}

// =========================================
// BÚSQUEDA GLOBAL
// =========================================
function setupSearch() {
  const btn = document.getElementById('search-btn');
  const overlay = document.getElementById('search-overlay');
  const closeBtn = document.getElementById('search-close');
  const input = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');
  let debounce;

  btn.addEventListener('click', () => { overlay.hidden = false; input.focus(); });
  closeBtn.addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    debounce = setTimeout(async () => {
      try {
        const data = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}`);
        resultsEl.innerHTML = renderSearchGroup('Pilotos', data.drivers) +
          renderSearchGroup('Equipos', data.constructors) + renderSearchGroup('Circuitos', data.circuits);
      } catch {
        resultsEl.innerHTML = `<div class="live-empty">No se pudo buscar en este momento.</div>`;
      }
    }, 250);
  });
}

function renderSearchGroup(label, items) {
  if (!items || !items.length) return '';
  return `<div class="search-result-group">
    <div class="search-result-group-label">${label}</div>
    ${items.map((it) => `<div class="search-result-item" data-action="search-result-click" data-type="${esc(it.type)}" data-id="${esc(it.id)}">
      <span>${esc(it.label)}</span><span class="sr-sub">${esc(it.sub || '')}</span>
    </div>`).join('')}
  </div>`;
}

function onSearchResultClick(type, id) {
  document.getElementById('search-overlay').hidden = true;
  if (type === 'driver') {
    switchTab('comparar');
    document.getElementById('compare-a').focus();
  } else if (type === 'constructor') {
    switchTab('posiciones');
    document.querySelector('[data-standings="constructors"]').click();
  } else if (type === 'circuit') {
    switchTab('historia');
    document.querySelector('[data-history="circuit"]').click();
    const sel = document.getElementById('history-circuit');
    sel.value = id;
    sel.dispatchEvent(new Event('change'));
  }
}

// =========================================
// CUENTA (Fase D — login/registro/perfil)
// =========================================
state.currentUser = null;

async function setupAccount() {
  const btn = document.getElementById('account-btn');
  const overlay = document.getElementById('account-overlay');
  const closeBtn = document.getElementById('account-close');

  btn.addEventListener('click', () => { overlay.hidden = false; renderAccountOverlay(); });
  closeBtn.addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

  try {
    const data = await fetchJSON('/api/auth/me');
    state.currentUser = data.user;
    btn.classList.toggle('is-logged', Boolean(data.user));
  } catch { /* sin sesión activa, se trata como anónimo */ }

  loadFavoriteKeys();
}

function renderAccountOverlay() {
  const titleEl = document.getElementById('account-title');
  const el = document.getElementById('account-content');

  if (state.currentUser) {
    titleEl.textContent = 'Mi cuenta';
    el.innerHTML = `
      <div class="account-profile">
        <div class="hero-title" style="font-size:16px">${esc(state.currentUser.nickname || state.currentUser.email)}</div>
        <div class="hero-meta">${esc(state.currentUser.email)}</div>
        ${state.currentUser.isAdmin ? '<p class="favorites-hint">Tenés permisos de administrador — <a href="/admin.html" style="color:var(--gold)">ir al panel</a>.</p>' : ''}
        <button class="retry-btn" style="width:100%;margin-top:16px" id="logout-btn">Cerrar sesión</button>
      </div>
    `;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      state.currentUser = null;
      document.getElementById('account-btn').classList.remove('is-logged');
      document.getElementById('account-overlay').hidden = true;
    });
    return;
  }

  titleEl.textContent = 'Ingresar';
  const oauthButtons = [
    state.config.oauthGoogle ? `<a href="/api/auth/oauth/google" class="oauth-btn">Continuar con Google</a>` : '',
    state.config.oauthGithub ? `<a href="/api/auth/oauth/github" class="oauth-btn">Continuar con GitHub</a>` : '',
  ].filter(Boolean).join('');

  el.innerHTML = `
    <form id="auth-form" class="auth-form">
      <input type="email" id="auth-email" placeholder="Email" required>
      <input type="password" id="auth-password" placeholder="Contraseña" minlength="8" required>
      <input type="text" id="auth-nickname" placeholder="Nombre (solo para registrarte)">
      <div id="auth-error" class="auth-error"></div>
      <button type="submit" class="retry-btn" style="width:100%">Ingresar</button>
      <button type="button" id="auth-register-btn" class="retry-btn-inline" style="width:100%;margin-top:8px;text-align:center">Crear cuenta nueva</button>
      <button type="button" id="auth-forgot-btn" class="auth-forgot-link">¿Olvidaste tu contraseña?</button>
    </form>
    ${oauthButtons ? `<div class="oauth-row">${oauthButtons}</div>` : ''}
  `;

  const form = document.getElementById('auth-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitAuth('/api/auth/login'); });
  document.getElementById('auth-register-btn').addEventListener('click', () => submitAuth('/api/auth/register'));
  document.getElementById('auth-forgot-btn').addEventListener('click', showForgotPasswordForm);
}

function showForgotPasswordForm() {
  document.getElementById('account-title').textContent = 'Recuperar contraseña';
  document.getElementById('account-content').innerHTML = `
    <form id="forgot-form" class="auth-form">
      <input type="email" id="forgot-email" placeholder="Tu email" required>
      <div id="forgot-msg" class="auth-error" style="color:var(--sub)"></div>
      <button type="submit" class="retry-btn" style="width:100%">Enviar link de recuperación</button>
      <button type="button" id="forgot-back" class="retry-btn-inline" style="width:100%;margin-top:8px;text-align:center">Volver</button>
    </form>
  `;
  document.getElementById('forgot-back').addEventListener('click', renderAccountOverlay);
  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value;
    const msgEl = document.getElementById('forgot-msg');
    msgEl.style.color = 'var(--sub)';
    msgEl.textContent = 'Enviando…';
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.sent) {
        msgEl.textContent = 'Listo — si el email existe, te llegó un link para elegir una contraseña nueva.';
      } else {
        msgEl.style.color = 'var(--red-hi)';
        msgEl.textContent = 'Esta función estará disponible próximamente. Mientras tanto, contactá al administrador del sitio.';
      }
    } catch {
      msgEl.style.color = 'var(--red-hi)';
      msgEl.textContent = 'No se pudo conectar. Probá de nuevo.';
    }
  });
}

/** Si la URL trae ?resetToken=..., abre directamente el formulario de
 * "elegir nueva contraseña" (llega acá desde el link del email). */
function handlePasswordResetLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('resetToken');
  if (!token) return;

  document.getElementById('account-overlay').hidden = false;
  document.getElementById('account-title').textContent = 'Elegir nueva contraseña';
  document.getElementById('account-content').innerHTML = `
    <form id="reset-form" class="auth-form">
      <input type="password" id="reset-password" placeholder="Contraseña nueva" minlength="8" required>
      <div id="reset-msg" class="auth-error"></div>
      <button type="submit" class="retry-btn" style="width:100%">Guardar</button>
    </form>
  `;
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = document.getElementById('reset-password').value;
    const msgEl = document.getElementById('reset-msg');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        msgEl.style.color = 'var(--sub)';
        msgEl.textContent = 'Contraseña actualizada — ya podés iniciar sesión.';
        window.history.replaceState({}, '', '/'); // saca el token de la URL
        setTimeout(renderAccountOverlay, 1200);
      } else {
        msgEl.style.color = 'var(--red-hi)';
        msgEl.textContent = data.error === 'invalid_or_expired_token' ? 'El link venció o ya se usó. Pedí uno nuevo.' : 'No se pudo actualizar la contraseña.';
      }
    } catch {
      msgEl.style.color = 'var(--red-hi)';
      msgEl.textContent = 'No se pudo conectar.';
    }
  });
}

async function submitAuth(endpoint) {
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const nickname = document.getElementById('auth-nickname').value;
  const errorEl = document.getElementById('auth-error');
  errorEl.textContent = '';

  const { ok, networkError, serverError, data } = await safeRequest(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, nickname }),
  });

  if (networkError) { errorEl.textContent = 'No hay conexión. Revisá tu internet y probá de nuevo.'; return; }
  if (serverError) { errorEl.textContent = 'El servidor tuvo un problema inesperado. Probá de nuevo en un momento.'; return; }
  if (!ok) { errorEl.textContent = friendlyAuthError(data.error); return; }

  state.currentUser = data.user;
  document.getElementById('account-btn').classList.add('is-logged');
  renderAccountOverlay();
  loadFavoriteKeys();
  toast(endpoint.includes('register') ? '¡Cuenta creada! Ya iniciaste sesión.' : `¡Hola, ${data.user.nickname || data.user.email}!`);
}

function friendlyAuthError(code) {
  const map = {
    invalid_credentials: 'Email o contraseña incorrectos.',
    email_taken: 'Ya existe una cuenta con ese email.',
    weak_password: 'La contraseña debe tener al menos 8 caracteres.',
    invalid_email: 'Ese email no parece válido.',
    rate_limited: 'Demasiados intentos. Probá de nuevo en unos minutos.',
    not_configured: 'Esta función estará disponible próximamente.',
  };
  return map[code] || 'Algo salió mal. Probá de nuevo.';
}

// =========================================
// ENCUESTA DEL GP (Fase A)
// =========================================
async function loadPoll() {
  const el = document.getElementById('poll-widget');
  if (!state.config.likesAndVotesAndFavorites) { el.innerHTML = ''; return; }
  clearInterval(state.pollCountdownTimer);
  clearInterval(state.pollRefreshTimer);
  try {
    const data = await fetchJSON('/api/poll');
    if (!data.configured || !data.poll) { el.innerHTML = ''; return; }
    renderPoll(data.poll);

    // Mientras esté abierta, refrescamos los porcentajes solos cada 20s
    // (misma cadencia que En Vivo) para que se sienta "viva".
    if (data.poll.isOpen) {
      state.pollRefreshTimer = setInterval(async () => {
        if (state.activeTab !== 'calendario') return;
        try { const fresh = await fetchJSON('/api/poll'); if (fresh.poll) renderPoll(fresh.poll); } catch {}
      }, 20000);
    }
  } catch { el.innerHTML = ''; }
}

function renderPoll(poll) {
  const el = document.getElementById('poll-widget');
  const question = poll.sessionType === 'sprint' ? `¿Quién ganará la Sprint?` : `¿Quién ganará el ${poll.raceName}?`;

  if (!poll.options.length) { el.innerHTML = ''; return; }

  if (poll.isClosed) {
    const winner = poll.options.find((o) => o.driverId === poll.winnerDriverId);
    const yourVoteOption = poll.options.find((o) => o.driverId === poll.yourVote);
    const hitRate = winner ? winner.percentage : null;
    el.innerHTML = `<div class="poll-card poll-closed">
      <div class="poll-eyebrow">🏆 Encuesta cerrada</div>
      <div class="poll-title">${question}</div>
      <div class="poll-closed-note">${poll.totalVotes} personas votaron
        ${winner ? ` · ganó <b>${winner.name}</b> (lo eligió el ${hitRate}% de la comunidad)` : ' · resultado real todavía no está cargado'}
        ${poll.yourVote ? (poll.yourVote === poll.winnerDriverId ? ' · ¡acertaste! 🎉' : ` · vos votaste ${yourVoteOption?.name ?? ''}`) : ''}
      </div>
    </div>`;
    return;
  }

  el.innerHTML = `<div class="poll-card poll-open">
    <div class="poll-eyebrow pulsing"><span class="dot"></span>ENCUESTA DE LA COMUNIDAD</div>
    <div class="poll-title">${question}</div>
    <div class="poll-meta-row">
      <span>👥 ${poll.totalVotes} ${poll.totalVotes === 1 ? 'voto' : 'votos'}</span>
      <span id="poll-countdown">cierra en —</span>
    </div>
    ${poll.options.map((o) => `
      <div class="poll-option ${poll.yourVote === o.driverId ? 'selected' : ''}">
        <div class="poll-option-fill" style="width:${o.percentage}%"></div>
        <button data-action="vote-poll" data-poll-id="${poll.id}" data-driver-id="${esc(o.driverId)}">
          <div class="poll-option-row"><span>${poll.yourVote === o.driverId ? '✓ ' : ''}${o.name}</span><span>${o.percentage}% (${o.votes})</span></div>
        </button>
      </div>
    `).join('')}
    <div class="poll-footer-note">${poll.yourVote ? 'Ya votaste — podés cambiar tu elección mientras la encuesta siga abierta.' : 'Un voto por persona. Se cierra apenas larga la sesión.'}</div>
  </div>`;

  startPollCountdown(new Date(poll.closesAt));
}

function startPollCountdown(target) {
  const el = document.getElementById('poll-countdown');
  if (!el) return;
  const tick = () => {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) { el.textContent = 'cerrando…'; clearInterval(state.pollCountdownTimer); loadPoll(); return; }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    el.textContent = h > 0 ? `cierra en ${h}h ${m}m` : `cierra en ${m}m`;
  };
  tick();
  state.pollCountdownTimer = setInterval(tick, 30000);
}

async function votePoll(pollId, driverId) {
  const { ok, networkError, serverError, data } = await safeRequest('/api/poll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pollId, driverId }),
  });

  if (networkError) { toast('No hay conexión. Revisá tu internet.'); return; }
  if (serverError) { toast('El servidor tuvo un problema. Probá de nuevo.'); return; }
  if (!ok) {
    toast(data?.error === 'poll_closed' ? 'La votación ya cerró para este Gran Premio.' : 'No se pudo registrar tu voto. Probá de nuevo.');
    return;
  }
  toast('¡Voto registrado! 🏁');
  loadPoll();
}

// =========================================
// NOTIFICACIONES PUSH
//
// Clave pública VAPID — es información pública por diseño (la privada
// vive SOLO como secret en cron-worker, nunca acá). Si regenerás el
// par de claves, actualizá esta constante para que coincida.
// =========================================
const VAPID_PUBLIC_KEY = 'BLz0gv6C_2sAzmsbf_YA8x3OD9P50O9GdjV_Tsy72QgNmZe1niqotskk_ZkSEGpHPrB8onSFWI7cYpjn6Ss7wfA';

function setupPush() {
  const btn = document.getElementById('notify-btn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { btn.hidden = true; return; }

  updatePushButtonState();

  try {
    if (!localStorage.getItem('f1hub_seen_notify_hint')) {
      setTimeout(() => toast('🔔 Tocá la campana para recibir un aviso antes de que arranque cada sesión.'), 1500);
      localStorage.setItem('f1hub_seen_notify_hint', '1');
    }
  } catch { /* localStorage puede estar bloqueado (modo privado); no es crítico */ }

  btn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') {
      await unsubscribePush();
    } else {
      await subscribePush();
    }
    updatePushButtonState();
  });
}

async function updatePushButtonState() {
  const btn = document.getElementById('notify-btn');
  const isOn = 'Notification' in window && Notification.permission === 'granted';
  btn.classList.toggle('is-logged', isOn);
  btn.title = isOn ? 'Notificaciones activadas (tocá para desactivar)' : 'Activar avisos antes de cada sesión';
}

async function subscribePush() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });

    toast('Avisos activados. Nota: solo van a llegar si el sitio ya tiene desplegado el servicio de notificaciones (cron-worker) — si no estás seguro, preguntale al administrador del sitio.');
  } catch (err) {
    console.warn('No se pudo activar notificaciones:', err);
  }
}

async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
  } catch (err) {
    console.warn('No se pudo desactivar notificaciones:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
