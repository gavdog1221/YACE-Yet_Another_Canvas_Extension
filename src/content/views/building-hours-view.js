import { computeBuildingStatus, openHours } from '../services/building-hours-static.js';
import { escapeHTML } from '../utils/text.js';

// Campus & Tools "Hours" tab — building cards (MUB, Hamel Rec, Dimond Library,
// Kingsbury Library).
//
// The schedule is bundled (services/building-hours-static.js) rather than
// scraped, so this tab renders synchronously with no network calls at all.
// Each card still links out to the live source, since UNH posts separate
// schedules for finals week, winter break and holidays.

export function renderBuildingHoursView(listContainer) {
    if (!listContainer) return;

    const buildings = openHours();

    listContainer.innerHTML = `
      <div class="bh-tab-scroll">
      <div class="bh-head">
      <span class="bh-title">🏢 Building Hours</span>
      <span class="bh-sub">Campus buildings and the services inside them — hours shift for breaks, so each card links to the live source.</span>
      </div>
      <div class="bh-grid">
      ${buildings.map(renderBuildingCard).join('')}
      </div>
      </div>`;
  }

function renderBuildingCard(b) {
    const status = computeBuildingStatus(b);
    const sectionsHtml = (b.sections || []).map(renderSection).join('');
    return `
    <div class="bh-card">
    <div class="bh-card-head">
    <span class="bh-name">${escapeHTML(b.icon || '🏢')} ${escapeHTML(b.name)}</span>
    <a class="bh-source" href="${escapeHTML(b.link)}" target="_blank" rel="noopener noreferrer" title="Open the live hours page">↗</a>
    </div>
    <div class="bh-status ${status.isOpen ? 'is-open' : 'is-closed'}"><span class="bh-dot"></span>${escapeHTML(status.label)}</div>
    ${sectionsHtml}
    </div>`;
  }

function renderSection(section) {
    if (!section || !Array.isArray(section.rows) || !section.rows.length) return '';
    const todayIdx = new Date().getDay();
    const rowsHtml = section.rows.map(r => renderRow(r, todayIdx)).join('');
    return `
    <div class="bh-section">
    ${section.name ? `<div class="bh-section-name">${escapeHTML(section.name)}</div>` : ''}
    <div class="bh-rows">
    ${rowsHtml}
    </div>
    </div>`;
  }

function renderRow(r, todayIdx) {
    const isToday = r.days.indexOf(todayIdx) !== -1;
    const timeHtml = r.closed
      ? '<span class="bh-time is-closed">Closed</span>'
      : `<span class="bh-time">${(r.spans || []).map(sp => `${escapeHTML(sp.startDisp)} – ${escapeHTML(sp.endDisp)}`).join(' <span class="bh-sep">·</span> ') || escapeHTML(r.raw || '')}</span>`;
    return `<div class="bh-row${isToday ? ' is-today' : ''}"><span class="bh-day">${escapeHTML(r.label)}</span>${timeHtml}</div>`;
  }