import {
  CALENDAR_ICS_URL,
  CALENDAR_PAGE_URL,
  countDaysOffInMonth,
  daysUntil,
  dominantKind,
  fetchAcademicCalendar,
  indexDaysByDate,
  upcomingRuns,
} from '../services/calendar-api.js';
import { localDateKey } from '../utils/dates.js';
import { escapeHTML } from '../utils/text.js';

// Campus & Tools "Days Off" tab — a month calendar of UNH holidays, breaks,
// reading days and schedule changes, plus a countdown to the next one.
//
// Everything is derived from the Registrar's live academic-calendar feed
// (services/calendar-api.js), so it self-updates: the registrar posts holidays
// and breaks a year ahead, and last-minute notices (schedule changes, campus
// closures) land in the same feed. The bundled Fall 2026 snapshot only shows up
// when the feed is unreachable, and is labelled as such.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// Session-only view state. `monthOffset` is relative to today (0 = the current
// month) and `selected` is a YYYY-MM-DD key. Note that because
// campus-tools-modal keeps the tab's DOM alive in its toolHosts map, re-opening
// the tab replays this state rather than starting over — only the "Today"
// button resets monthOffset to 0.
const view = { monthOffset: 0, selected: null, filter: 'off' };

// 'off' = only holidays/breaks/closures/schedule changes; 'all' = every key date
// (classes begin/end, exams, census day) too.
function activeKinds() {
  return view.filter === 'all' ? ['off', 'special', 'milestone'] : ['off', 'special'];
}

export async function renderDaysOffView(container) {
    if (!container) return;

    container.innerHTML = `
    <div class="do-tab-scroll">
      <div class="do-loading">
        <span class="do-loading-label">Loading the UNH academic calendar…</span>
      </div>
    </div>`;

    let cache = null;
    try {
      cache = await fetchAcademicCalendar();
    } catch (e) {
      cache = null;
    }

    container.innerHTML = `
    <div class="do-tab-scroll">
      <div class="do-view-header">
        <span class="do-title">🌴 Days Off</span>
        <span class="do-sub">${escapeHTML(sourceLine(cache))}</span>
      </div>
      <div id="do-panel"></div>
    </div>`;

    const panel = container.querySelector('#do-panel');
    if (!cache) {
      panel.innerHTML = '<div class="do-empty">Could not load the UNH academic calendar. Try again in a moment.</div>';
      return;
    }
    paint(panel, cache);
  }

function sourceLine(cache) {
  if (!cache) return 'Could not reach the UNH academic calendar.';
  if (cache.source === 'snapshot') {
    return 'Showing a bundled Fall 2026 snapshot — the UNH calendar feed could not be reached.';
  }
  if (cache.source === 'stale') {
    const when = cache.fetchedAt ? relativeTime(cache.fetchedAt) : 'earlier';
    return `Could not refresh from UNH — showing the copy cached ${escapeHTML(when)}.`;
  }
  return `Live from the UNH Registrar's academic calendar — ${escapeHTML(relativeTime(cache.fetchedAt))}.`;
}

function relativeTime(ts) {
  if (!ts) return 'unknown';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ---------------------------------------------------------------------------
 * Painting
 * ------------------------------------------------------------------------- */

function paint(panel, cache) {
  const now = new Date();
  const anchor = new Date(now.getFullYear(), now.getMonth() + view.monthOffset, 1);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const byDate = indexDaysByDate(cache);
  const todayKey = localDateKey(now);
  const kinds = activeKinds();

  panel.innerHTML = `
  ${renderHero(cache)}
  <div class="do-controls">
    <div class="do-filter-pills">
      <button type="button" class="do-pill ${view.filter === 'off' ? 'active' : ''}" data-filter="off">Days off</button>
      <button type="button" class="do-pill ${view.filter === 'all' ? 'active' : ''}" data-filter="all">All key dates</button>
    </div>
    <div class="do-month-nav">
      <button type="button" class="do-nav-btn" id="do-prev" title="Previous month" aria-label="Previous month">◀</button>
      <span class="do-month-label" id="do-month-label">${escapeHTML(MONTH_LABELS[month])} ${year}</span>
      <button type="button" class="do-nav-btn" id="do-next" title="Next month" aria-label="Next month">▶</button>
      <button type="button" class="do-today-btn" id="do-today">Today</button>
    </div>
  </div>
  <div class="do-cal">
    <div class="do-dow-row">${WEEKDAY_LABELS.map(d => `<span class="do-dow">${d}</span>`).join('')}</div>
    <div class="do-grid">${buildGridCells(year, month, byDate, todayKey, kinds)}</div>
    <div class="do-legend">
      <span class="do-legend-item"><span class="do-legend-swatch is-off"></span>No classes</span>
      <span class="do-legend-item"><span class="do-legend-swatch is-special"></span>Modified / alert</span>
      <span class="do-legend-item"><span class="do-legend-swatch is-milestone"></span>Key date</span>
      <span class="do-legend-item"><span class="do-legend-ring"></span>Today</span>
    </div>
    <div class="do-month-stat">${escapeHTML(monthStat(cache, year, month))}</div>
  </div>
  ${renderDetail(byDate)}
  ${renderUpcoming(cache)}
  <div class="do-foot">
    <a href="${escapeHTML(CALENDAR_PAGE_URL)}" target="_blank" rel="noopener noreferrer">Registrar's academic calendar →</a> ·
    <a href="${escapeHTML(CALENDAR_ICS_URL)}" target="_blank" rel="noopener noreferrer">raw feed</a>
  </div>`;

  wirePanel(panel, cache);
}

function buildGridCells(year, month, byDate, todayKey, kinds) {
  const lead = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  while (cells.length > 42) cells.pop();

  return cells.map(day => {
    if (!day) return '<div class="do-cell is-empty"></div>';

    const dateKey = localDateKey(new Date(year, month, day));
    const entries = byDate.get(dateKey) || [];
    const shown = entries.filter(e => kinds.indexOf(e.kind) >= 0);
    const dom = dominantKind(entries);
    const weekend = new Date(year, month, day).getDay() === 0
      || new Date(year, month, day).getDay() === 6;

    const classes = ['do-cell'];
    if (weekend) classes.push('is-weekend');
    if (dateKey === todayKey) classes.push('is-today');
    if (view.selected === dateKey) classes.push('is-selected');
    if (shown.length) classes.push('has-' + dom.kind);
    else if (entries.length) classes.push('is-muted');

    const tooltip = entries.length
      ? entries.map(e => e.title).join(' • ')
      : '';
    const chips = shown.slice(0, 2).map(e => {
      const chipClass = 'do-chip is-' + e.kind + (e.alert ? ' is-alert' : '');
      return `<span class="${chipClass}">${escapeHTML(e.label)}</span>`;
    }).join('');
    const more = shown.length > 2 ? `<span class="do-chip is-more">+${shown.length - 2}</span>` : '';

    return `
    <button type="button" class="${classes.join(' ')}" data-date="${dateKey}" title="${escapeHTML(tooltip)}">
      <span class="do-cell-num">${day}</span>
      <span class="do-cell-chips">${chips}${more}</span>
    </button>`;
  }).join('');
}

function renderHero(cache) {
  const offRuns = upcomingRuns(cache, ['off'], 1);
  const fallback = upcomingRuns(cache, ['off', 'special'], 1);
  const run = offRuns[0] || fallback[0];

  if (!run) {
    return `
    <div class="do-hero is-empty">
      <span class="do-hero-label">Next day off</span>
      <span class="do-hero-title">Nothing on the calendar ahead</span>
      <span class="do-hero-sub">The registrar hasn't posted upcoming holidays or breaks yet — check back later.</span>
    </div>`;
  }

  const until = daysUntil(run.start);
  const countdown = until === 0 ? 'Today' : until === 1 ? 'Tomorrow' : `In ${until} days`;
  const isSpecialOnly = run.kind === 'special';

  return `
  <div class="do-hero is-${escapeHTML(run.kind)}${run.alert ? ' is-alert' : ''}">
    <div class="do-hero-main">
      <span class="do-hero-label">${isSpecialOnly ? 'Next schedule change' : 'Next day off'}</span>
      <span class="do-hero-title">${escapeHTML(run.title)}</span>
      <span class="do-hero-when">${escapeHTML(formatRunDate(run))}</span>
    </div>
    <div class="do-hero-count">
      <span class="do-hero-countdown">${escapeHTML(countdown)}</span>
      ${run.days > 1 ? `<span class="do-hero-span">${run.days} days</span>` : ''}
    </div>
  </div>`;
}

function renderDetail(byDate) {
  const entries = view.selected ? (byDate.get(view.selected) || []) : [];
  if (!view.selected) {
    return '<div class="do-detail is-idle">Pick a highlighted day to see what the registrar posted for it.</div>';
  }
  if (!entries.length) {
    return `<div class="do-detail is-idle">${escapeHTML(formatLongDate(view.selected))} — no calendar entries.</div>`;
  }
  return `
  <div class="do-detail">
    <div class="do-detail-head">${escapeHTML(formatLongDate(view.selected))}</div>
    <ul class="do-detail-list">
      ${entries.map(e => `
        <li class="do-detail-row is-${escapeHTML(e.kind)}">
          <span class="do-detail-badge">${escapeHTML(e.label)}</span>
          <span class="do-detail-title">${escapeHTML(e.title)}</span>
          ${e.url ? `<a class="do-detail-link" href="${escapeHTML(e.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}
        </li>`).join('')}
    </ul>
  </div>`;
}

function renderUpcoming(cache) {
  const runs = upcomingRuns(cache, activeKinds(), 12);
  const title = view.filter === 'all' ? 'Upcoming key dates' : 'Upcoming days off';

  if (!runs.length) {
    return `
    <section class="do-section">
      <h3 class="do-section-title">${escapeHTML(title)}</h3>
      <div class="do-empty">Nothing else on the calendar in the feed's window.</div>
    </section>`;
  }

  return `
  <section class="do-section">
    <h3 class="do-section-title">${escapeHTML(title)}</h3>
    <div class="do-run-list">
    ${runs.map(run => {
      const until = daysUntil(run.start);
      const countdown = until === 0 ? 'today' : until === 1 ? 'tomorrow' : `in ${until}d`;
      return `
      <div class="do-run is-${escapeHTML(run.kind)}${run.alert ? ' is-alert' : ''}">
        <span class="do-run-date">${escapeHTML(formatRunDate(run))}</span>
        <span class="do-run-body">
          <span class="do-run-title">${escapeHTML(run.title)}</span>
          <span class="do-run-meta">${run.days > 1 ? `${run.days}-day stretch · ` : ''}${escapeHTML(countdown)}</span>
        </span>
        ${run.url ? `<a class="do-run-link" href="${escapeHTML(run.url)}" target="_blank" rel="noopener noreferrer" title="Open in the registrar calendar">↗</a>` : ''}
      </div>`;
    }).join('')}
    </div>
  </section>`;
}

function monthStat(cache, year, month) {
  const off = countDaysOffInMonth(cache, year, month);
  if (off === 0) return `${MONTH_LABELS[month]} ${year} — no days off on the calendar.`;
  return `${MONTH_LABELS[month]} ${year} — ${off} day${off === 1 ? '' : 's'} off.`;
}

/* ---------------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------------- */

function wirePanel(panel, cache) {
  panel.querySelectorAll('.do-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      view.filter = pill.getAttribute('data-filter');
      paint(panel, cache);
    });
  });

  const prev = panel.querySelector('#do-prev');
  const next = panel.querySelector('#do-next');
  const today = panel.querySelector('#do-today');
  if (prev) prev.addEventListener('click', () => { view.monthOffset -= 1; paint(panel, cache); });
  if (next) next.addEventListener('click', () => { view.monthOffset += 1; paint(panel, cache); });
  if (today) {
    today.addEventListener('click', () => {
      view.monthOffset = 0;
      view.selected = null;
      paint(panel, cache);
    });
  }

  panel.querySelectorAll('.do-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      view.selected = cell.getAttribute('data-date');
      paint(panel, cache);
    });
  });
}

/* ---------------------------------------------------------------------------
 * Date formatting
 * ------------------------------------------------------------------------- */

function formatLongDate(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  if (isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// "Monday, October 12" for a one-day run, "Wed, Nov 26 – Fri, Nov 27" for a span.
function formatRunDate(run) {
  if (!run.start) return '';
  const start = new Date(run.start + 'T00:00:00');
  if (isNaN(start.getTime())) return run.start;
  if (!run.end || run.end === run.start) {
    return start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
  const end = new Date(run.end + 'T00:00:00');
  const sameMonth = start.getMonth() === end.getMonth();
  const left = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const right = end.toLocaleDateString(undefined, sameMonth
    ? { weekday: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
  return `${left} – ${right}`;
}