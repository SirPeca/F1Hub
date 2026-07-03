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

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupStandingsControls();
  setupHistoryControls();
  loadCalendar();
});

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
    document.getElementById('season-label').textContent = `Temporada ${calendarData.season}`;
    renderHero();
    renderCalendarList();
    updateHeaderStatus();
  } catch (err) {
    heroEl.textContent = 'No se pudo cargar el calendario. Reintentá en unos minutos.';
    listEl.textContent = '';
  }
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
    if (!data.standings.length) {
      el.innerHTML = `<div class="live-empty">${data.note || 'Sin datos para esta temporada.'}</div>`;
      return;
    }
    el.innerHTML = data.standings.map((s) => {
      if (type === 'drivers') {
        return `<div class="st-row ${s.position <= 3 ? 'top3' : ''}">
          <span class="st-pos">${s.position}</span>
          <div class="st-main">
            <div class="st-name">${s.name}</div>
            <div class="st-sub"><span class="team-dot" style="background:${teamColor(s.constructors[0])}"></span>${s.constructors.join(' / ')}</div>
          </div>
          <div><span class="st-points">${s.points}</span><span class="st-wins">${s.wins} victorias</span></div>
        </div>`;
      }
      return `<div class="st-row ${s.position <= 3 ? 'top3' : ''}">
        <span class="st-pos">${s.position}</span>
        <div class="st-main">
          <div class="st-name"><span class="team-dot" style="background:${teamColor(s.name)};display:inline-block;margin-right:6px"></span>${s.name}</div>
        </div>
        <div><span class="st-points">${s.points}</span><span class="st-wins">${s.wins} victorias</span></div>
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
let circuitsCache = null;

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
    circuitsCache = data.circuits;
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
    el.innerHTML = `
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
    if (!data.winners.length) {
      el.innerHTML = `<div class="live-empty">Sin datos históricos para este circuito.</div>`;
      return;
    }
    el.innerHTML = `<h3 class="section-title" style="margin-top:0">${data.circuitName}</h3>` +
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
        <div class="news-meta"><span>${n.source}</span><span>${fmtDate(n.pubDate)} · ${fmtTime(n.pubDate)}</span></div>
        <div class="news-title">${n.title}</div>
        ${n.summary ? `<div class="news-summary">${n.summary}</div>` : ''}
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
}
