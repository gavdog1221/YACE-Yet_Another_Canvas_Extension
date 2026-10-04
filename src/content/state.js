// Centralized mutable store. Every module that used to read/write one of the
// top-level `let` bindings in the old content.js closure now does
// `import { state } from '../state.js'` and reads/writes `state.<name>`
// instead -- this preserves the original single-shared-instance behavior
// across an ES module graph (bare `let` exports can't be reassigned from
// importing modules, so a plain object is used instead of many `let` exports).

import {
  STORAGE_KEY_THEME,
  STORAGE_KEY_WHATIF,
  STORAGE_KEY_DOM_COLORS,
  STORAGE_KEY_OPTIONS,
  STORAGE_KEY_CALENDAR_CACHE,
} from './constants.js';

export const state = {
  currentTheme: localStorage.getItem(STORAGE_KEY_THEME) || 'cyan',

  currentTab: 'upcoming',
  activeCourseFilter: 'ALL',
  activeDayFilter: null,
  assignmentRangeFilter: '2weeks', // 'today' | 'week' | '2weeks' | 'month' | 'all'
  searchQuery: '',
  isHiddenMenuOpen: false,

  cachedCourseMap: {},
  cachedGrades: [],
  cachedCoursePercentages: {},
  whatIfScores: {},
  // The What-If simulator renders as a collapsed dropdown by default; the
  // flag is in-memory only so typing in the matrix mid-session doesn't
  // collapse it on every re-render, but it resets to collapsed per load.
  whatIfExpanded: false,
  gradeChangeAlerts: [],
  domCourseColors: {},
  cachedAnnouncements: [],
  cachedUnreadInboxCount: 0,

  // The widget no longer has a sidebar or minimize-to-edge mode: the
  // fullscreen dashboard is the only thing. Kept as a flag because
  // renderCurrentView / setWidgetFullscreen still branch on it.
  isFullscreen: true,
  // Dedicated popup/drawer state for the Campus & Tools overlay (Food + WebCat
  // Reg). Toggling it must never touch the dashboard: the search bar, weekday
  // pills and active filters stay mounted above ASSIGNMENTS regardless.
  isDrawerOpen: false,

  // Set right before a render that really changes scrape-derived data
  // (loadTasks completion, hide/unhide of courses). The fullscreen dashboard
  // re-mounts the Grades/News/Info panels by default so button clicks never
  // reset their scroll/what-if state; this flag forces them to rebuild.
  forceDashboardRebuild: false,

  selectedTaskIndex: -1,
  cachedDiningMenu: null,
  activeDiningHall: 80, // 80 = Holloway Commons (HoCo), 30 = Philbrook (Philly), 50 = Stillings

  showAllCompleted: false,
  showAllOverdue: false,
  lastViewSignature: '',
  gradesSortMode: 'recent', // 'recent' | 'highest' | 'lowest'

  // --- Custom Assignment Maker state ---
  editingAssignmentId: null,
  modalSelectedDays: new Set(),
  modalSelectedColor: '',

  // --- Dining view state ---
  diningCache: {
    date: null,
    80: null, // HoCo
    30: null, // Philly
  },
  // Menus peeked for other days (tomorrow, …), keyed by toDateString().
  diningByDateCache: {},
  cachedOfficialHours: null,
  activeStationFilter: '__DEFAULT__',
  activeDiningDayOffset: 0, // 0 = today, 1 = tomorrow

  // --- Options (tab visibility, notification prefs, …) ---
  // Hydrated from STORAGE_KEY_OPTIONS below; options.js owns the write path.
  options: {},

  // --- UNH academic calendar (days off) ---
  // { source: 'live'|'stale'|'snapshot', fetchedAt, calName, days: [...] }
  // persisted under STORAGE_KEY_CALENDAR_CACHE. The day list itself is the
  // parsed ICS (one entry per covered day), owned by services/calendar-api.js.
  calendarCache: null,
};

try {
  state.whatIfScores = JSON.parse(localStorage.getItem(STORAGE_KEY_WHATIF) || '{}');
} catch {
  state.whatIfScores = {};
}

try {
  state.domCourseColors = JSON.parse(localStorage.getItem(STORAGE_KEY_DOM_COLORS) || '{}');
} catch {
  state.domCourseColors = {};
}

try {
  state.options = JSON.parse(localStorage.getItem(STORAGE_KEY_OPTIONS) || '{}');
} catch {
  state.options = {};
}

try {
  state.calendarCache = JSON.parse(localStorage.getItem(STORAGE_KEY_CALENDAR_CACHE) || 'null');
} catch {
  state.calendarCache = null;
}
