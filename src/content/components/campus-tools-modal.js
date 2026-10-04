// Campus & Tools overlay: hosts the Food (dining menus), Professor ratings
// and WebCat Reg widgets that were removed from the fullscreen dashboard
// grid. A single modal with a three-tab switcher; the view renderers are
// shared with the old tab bodies so they behave identically, just hosted in
// an overlay instead.
//
// Reuses the .doc-preview-modal chrome (backdrop + dialog + close) so the
// existing keyboard/modal plumbing (Esc handling, "any modal open" gate in
// keyboard-shortcuts.js) applies for free.

import { state } from '../state.js';
import { renderBuildingHoursView } from '../views/building-hours-view.js';
import { renderDaysOffView } from '../views/days-off-view.js';
import { renderDiningView } from '../views/dining-view.js';
import { renderExportView } from '../views/export-view.js';
import { renderOptionsView } from '../views/options-view.js';
import { renderRegistrationView } from '../views/registration-view.js';
import { renderRmpView } from '../views/rmp-view.js';
import { renderNotificationsView } from '../views/notifications-view.js';
import { getHiddenCourses } from '../storage/hidden-courses.js';

// Which tab shows next time the modal opens
// ('food' | 'rmp' | 'registration' | 'buildings' | 'days' | 'notifications' | 'export' | 'options').
let activeTool = 'food';

// Reflect state.isDrawerOpen + the active tool on every 🍽/🧑‍🏫/🎓 header
// button so the one matching the open tab lights up, not a one-way "open".
function syncCampusToolsBtn() {
    const isOpen = state.isDrawerOpen;
    document.querySelectorAll('.campus-tools-btn').forEach(btn => {
      const tool = btn.getAttribute('data-tool');
      btn.classList.toggle('is-active', isOpen && tool === activeTool);
      btn.setAttribute('aria-expanded', String(isOpen));
    });
  }

// CSS custom properties are defined on #module-tasks-widget only; a modal
// appended to <body> sits outside it, so copy the live palette onto the
// modal element so var(--primary-accent) etc. resolve inside the overlay.
function applyThemePalette(modal) {
    const widget = document.getElementById('module-tasks-widget');
    if (!widget) return;
    const cs = getComputedStyle(widget);
    [
      '--primary-accent', '--secondary-accent', '--accent-glow', '--accent-soft',
      '--card-bg', '--border-subtle', '--glass-obsidian', '--glass-obsidian-2',
      '--glass-edge', '--text-primary', '--text-secondary', '--text-tertiary',
      '--danger', '--danger-soft', '--warning', '--warning-soft',
      '--success', '--success-soft', '--gold', '--purple',
      '--shadow-panel', '--shadow-card', '--shadow-card-hover', '--shadow-float'
    ].forEach(name => {
      const val = cs.getPropertyValue(name);
      if (val) modal.style.setProperty(name, val);
    });
  }

// Every tool renderer is invoked ONLY from renderTool() below, which itself
// only runs from openCampusToolsModal() or a tab click — never at import time,
// never from the widget's load path. So nothing scrapes until you actually
// click a header button or a tab.
//
// Each rendered tab is then KEPT ALIVE in toolHosts rather than thrown away.
// body.replaceChildren() detaches the outgoing tab (it stays in the map), and
// returning to a tab — or just closing and reopening the modal — re-attaches
// that same DOM instead of re-running the view, which for the dining,
// professor and calendar tabs means no second network round-trip.
//
// The nodes are held, NOT serialized: caching an innerHTML string would
// re-parse the markup on restore and silently drop every addEventListener the
// view attached (dining hall/day pills, calendar month grid, WebCat inputs).
// Detaching and re-attaching the same nodes preserves those listeners, which
// also means per-tab UI state (selected hall, open month, typed CRNs) sticks
// the way a user expects. A full page reload re-renders from scratch, since
// that is also when the underlying data may have changed.
const toolHosts = new Map(); // tool -> the element that holds that tab's DOM

function renderTool() {
    const modal = document.getElementById('campus-tools-modal');
    const body = document.getElementById('campus-tools-body');
    if (!modal || !body) return;

    modal.querySelectorAll('.campus-tools-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === activeTool);
    });

    // Already rendered this session? Just put its live DOM back.
    const host = toolHosts.get(activeTool);
    if (host) {
      body.replaceChildren(host);
      return;
    }

    // Fresh render. Each tab owns a wrapper element that we keep in toolHosts
    // forever, so switching tabs only moves the wrapper. The wrapper is never
    // display:none'd while loading — several views measure their own layout,
// and a hidden ancestor would hand them zero widths.
    const holder = document.createElement('div');
    holder.className = 'campus-tools-tool';
    if (activeTool === 'food') {
      renderDiningView(holder);
    } else if (activeTool === 'rmp') {
      renderRmpView(holder, getHiddenCourses());
    } else if (activeTool === 'buildings') {
      renderBuildingHoursView(holder);
    } else if (activeTool === 'days') {
      renderDaysOffView(holder);
    } else if (activeTool === 'notifications') {
      renderNotificationsView(holder);
    } else if (activeTool === 'export') {
      renderExportView(holder);
    } else if (activeTool === 'options') {
      renderOptionsView(holder);
    } else {
      renderRegistrationView(holder);
    }

    // Remember the holder BEFORE moving it into the body, so a re-render
    // triggered from inside the view (the Options tab re-renders itself on a
    // theme change) still lands in the node we are tracking.
    toolHosts.set(activeTool, holder);
    body.replaceChildren(holder);
  }

// The Options tab can switch themes while the modal is open — refresh the CSS
// custom properties the modal copied from the widget on open.
export function refreshCampusToolsPalette() {
    const modal = document.getElementById('campus-tools-modal');
    if (modal) applyThemePalette(modal);
  }

export function openCampusToolsModal(tool) {
    state.isDrawerOpen = true;

    if (tool && tool !== activeTool) {
      activeTool = tool;
    }

    let modal = document.getElementById('campus-tools-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'campus-tools-modal';
      modal.className = 'doc-preview-modal campus-tools-modal';
      modal.innerHTML = `
      <div class="doc-preview-backdrop"></div>
      <div class="doc-preview-dialog campus-tools-dialog">
      <div class="doc-preview-header campus-tools-header">
      <span class="doc-preview-title">🍽 Campus &amp; Tools</span>
      <div class="campus-tools-tabs" role="tablist">
      <button type="button" class="campus-tools-tab" data-tool="food" role="tab">🍽 Food</button>
      <button type="button" class="campus-tools-tab" data-tool="rmp" role="tab">🧑‍🏫 Professors</button>
      <button type="button" class="campus-tools-tab" data-tool="registration" role="tab">🎓 WebCat Reg</button>
      <button type="button" class="campus-tools-tab" data-tool="buildings" role="tab">🏢 Hours</button>
      <button type="button" class="campus-tools-tab" data-tool="days" role="tab">🌴 Days Off</button>
      <button type="button" class="campus-tools-tab" data-tool="notifications" role="tab">🔔 Alerts</button>
      <button type="button" class="campus-tools-tab" data-tool="export" role="tab">📅 Export</button>
      <button type="button" class="campus-tools-tab" data-tool="options" role="tab">⚙️ Options</button>
      </div>
      <button type="button" class="doc-preview-close" id="campus-tools-close-btn" title="Close (Esc)">✕</button>
      </div>
      <div class="campus-tools-body" id="campus-tools-body"></div>
      </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('.doc-preview-backdrop').addEventListener('click', closeCampusToolsModal);
      modal.querySelector('#campus-tools-close-btn').addEventListener('click', closeCampusToolsModal);

      // Esc anywhere inside the modal (including the reg text inputs, where
      // the window-level handler only blurs) closes it -- and stopPropagation
      // keeps the global handler from ALSO exiting fullscreen in one press.
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeCampusToolsModal();
        }
      });

      modal.querySelectorAll('.campus-tools-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          activeTool = btn.getAttribute('data-tool');
          renderTool();
        });
      });
    }

    applyThemePalette(modal);
    renderTool();
    modal.classList.add('is-open');
    syncCampusToolsBtn();
  }

export function closeCampusToolsModal() {
    state.isDrawerOpen = false;
    const modal = document.getElementById('campus-tools-modal');
    if (modal) modal.classList.remove('is-open');
    syncCampusToolsBtn();
  }

export function isCampusToolsModalOpen() {
    const modal = document.getElementById('campus-tools-modal');
    return !!(modal && modal.classList.contains('is-open'));
  }

// The header button is a true toggle: one press opens, the next closes.
// Driven entirely by state.isDrawerOpen / the modal's is-open class -- it
// never re-renders the dashboard underneath, so the search bar, weekday
// pills and active filters stay exactly where they were.
export function toggleCampusToolsModal(tool) {
    if (isCampusToolsModalOpen() || state.isDrawerOpen) {
      closeCampusToolsModal();
    } else {
      openCampusToolsModal(tool);
    }
  }