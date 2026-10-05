import { STORAGE_KEY_DASHBOARD_PANELS, STORAGE_KEY_DASHBOARD_PANEL_ORDER } from '../constants.js';

// Per-panel minimize state for the fullscreen dashboard (Assignments, News,
// Grades, Info, Schedule). Persisted in localStorage — dashboard-view.js reads
// it on every rebuild and re-derives the grid template (columns/rows/areas) from
// the visible set, so a collapsed panel's row/column reclaims its space instead
// of leaving a dead cell.

export function getCollapsedPanels() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_DASHBOARD_PANELS) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
      return {};
    }
  }

export function isPanelCollapsed(klass) {
    return getCollapsedPanels()[klass] === true;
  }

export function setPanelCollapsed(klass, collapsed) {
    const cur = getCollapsedPanels();
    if (collapsed) cur[klass] = true;
    else delete cur[klass];
    try {
      localStorage.setItem(STORAGE_KEY_DASHBOARD_PANELS, JSON.stringify(cur));
    } catch (e) {}
  }

export function resetPanelCollapsed() {
    try {
      localStorage.removeItem(STORAGE_KEY_DASHBOARD_PANELS);
    } catch (e) {}
  }

// --- Panel display order --------------------------------------------------
// The two SIDE tiles (News, Info) keep a user-draggable relative order and are
// the only entries in the array. Assignments, Grades and Schedule are PINNED and
// never appear in it: Assignments is the tall centre column, Grades the tall
// right column (it absorbed the former Recent Grades feed), and Schedule the
// full-width bottom row. Only two tiles exist now, so they map exactly onto the
// two left-hand slots — top and bottom.
//
// Existing installs hold a saved four-entry order ('news', 'recent-grades',
// 'grades', 'info'). sanitizeOrder() drops the keys that no longer exist and
// requires the remainder to be complete, so those upgrade to ['news','info']
// — news on top, info below — with no storage migration needed.
const DEFAULT_CONTENT_ORDER = ['news', 'info'];
const ALL_CONTENT_KEYS = ['news', 'info'];

function sanitizeOrder(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  raw.forEach((k) => {
    if (ALL_CONTENT_KEYS.includes(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  });
  return out.length === ALL_CONTENT_KEYS.length ? out : null;
}

export function hasPanelOrder() {
  try {
    return localStorage.getItem(STORAGE_KEY_DASHBOARD_PANEL_ORDER) !== null;
  } catch (e) {
    return false;
  }
}

export function getPanelOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_DASHBOARD_PANEL_ORDER) || 'null');
    return sanitizeOrder(raw) || [...DEFAULT_CONTENT_ORDER];
  } catch (e) {
    return [...DEFAULT_CONTENT_ORDER];
  }
}

export function setPanelOrder(order) {
  const clean = sanitizeOrder(order) || [...DEFAULT_CONTENT_ORDER];
  try {
    localStorage.setItem(STORAGE_KEY_DASHBOARD_PANEL_ORDER, JSON.stringify(clean));
  } catch (e) {}
  return clean;
}

export function resetPanelOrder() {
  try {
    localStorage.removeItem(STORAGE_KEY_DASHBOARD_PANEL_ORDER);
  } catch (e) {}
}