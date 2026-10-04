// Storage keys, color presets, and static config values.
// Moved verbatim out of the old content.js IIFE header (lines 2-21, 932, 102-111).

export const origin = window.location.origin;

export const STORAGE_KEY_DONE = 'canvas_mod_tasks_completed_v5';
export const STORAGE_KEY_CACHE = 'canvas_mod_tasks_cache_payload_v7';
export const STORAGE_KEY_CACHE_TIME = 'canvas_mod_tasks_cache_time_v7';
export const STORAGE_KEY_HIDDEN_COURSES = 'canvas_mod_tasks_hidden_courses_v1';
export const STORAGE_KEY_THEME = 'canvas_mod_tasks_theme_v1';
export const STORAGE_KEY_GRADES_CACHE = 'canvas_mod_tasks_grades_cache_v5';
export const STORAGE_KEY_GRADES_CACHE_TIME = 'canvas_mod_tasks_grades_cache_time_v5';
export const STORAGE_KEY_COURSE_PERCENTAGES = 'canvas_mod_tasks_course_pcts_v1';
export const STORAGE_KEY_WHATIF = 'canvas_mod_tasks_whatif_scores_v1';
export const STORAGE_KEY_DOM_COLORS = 'canvas_mod_tasks_dom_colors_v2';
export const STORAGE_KEY_STARRED = 'canvas_mod_tasks_starred_v1';
export const STORAGE_KEY_STARRED_ANNOUNCEMENTS = 'canvas_mod_tasks_starred_announcements_v1';
export const STORAGE_KEY_MINIMIZED = 'canvas_mod_tasks_minimized_v1';
export const STORAGE_KEY_ANNOUNCEMENTS_CACHE = 'canvas_mod_tasks_announcements_cache_v1';
export const STORAGE_KEY_SEEN_ANNOUNCEMENTS = 'canvas_mod_tasks_seen_announcements_v1';
export const STORAGE_KEY_CUSTOM_TASKS = 'canvas_mod_tasks_custom_assignments_v1';
export const STORAGE_KEY_CUSTOM_DUE = 'canvas_mod_tasks_custom_due_v1';
export const STORAGE_KEY_RMP_CACHE = 'canvas_mod_tasks_rmp_cache_v1';
export const STORAGE_KEY_GRADE_SNAPSHOT = 'canvas_mod_tasks_grade_snapshot_v1';
export const STORAGE_KEY_WHATS_NEW = 'canvas_mod_tasks_whats_new_v1';
export const STORAGE_KEY_NOTIFICATION_HISTORY = 'canvas_mod_tasks_notifications_v1';
export const STORAGE_KEY_OPTIONS = 'canvas_mod_tasks_options_v1';

export const STORAGE_KEY_DINING_MENUS = 'canvas_mod_tasks_dining_menus_v1';
export const STORAGE_KEY_ANNOUNCEMENTS_CACHE_TIME = 'canvas_mod_tasks_announcements_cache_time_v1';
export const STORAGE_KEY_SCHEDULE_CACHE = 'canvas_mod_tasks_schedule_cache_v1';
export const STORAGE_KEY_DASHBOARD_PANELS = 'canvas_mod_tasks_dashboard_panels_v1';
export const STORAGE_KEY_DASHBOARD_PANEL_ORDER = 'canvas_mod_tasks_dashboard_panel_order_v1';
export const STORAGE_KEY_NOTES = 'canvas_mod_tasks_notes_v1';
export const STORAGE_KEY_CALENDAR_CACHE = 'canvas_mod_tasks_calendar_cache_v1';

// Sticky-note accent hues (hex) shown as color dots on each note; the first
// one repeats the popover's overall accent so new notes blend in.
export const NOTE_COLORS = ['#ffd60a', '#ff9f0a', '#ff3b5c', '#5e5ce6', '#30d158', '#64d2ff'];

export const CUSTOM_COLOR_PRESETS = ['#0a84ff', '#ff375f', '#30d158', '#ff9f0a', '#bf5af2', '#ff2d55', '#ffd60a', '#64d2ff'];

export const THEMES = [
  { id: 'cyan', label: 'Liquid Blue', color: '#0a84ff' },
  { id: 'synthwave', label: 'Orchid Glass', color: '#bf5af2' },
  { id: 'emerald', label: 'Mint Glass', color: '#30d158' },
  { id: 'stealth', label: 'Graphite Glass', color: '#e5e5ea' },
  { id: 'sunset', label: 'Amber Glass', color: '#ff9f0a' },
  { id: 'crimson', label: 'Rose Glass', color: '#ff375f' },
  { id: 'indigo', label: 'Indigo Glass', color: '#5e5ce6' },
  { id: 'teal', label: 'Teal Glass', color: '#40c8e0' },
];

export const FALLBACK_PALETTES = [
  { accent: '#0a84ff', glow: 'rgba(10, 132, 255, 0.4)', soft: 'rgba(10, 132, 255, 0.16)' },
  { accent: '#bf5af2', glow: 'rgba(191, 90, 242, 0.4)', soft: 'rgba(191, 90, 242, 0.16)' },
  { accent: '#30d158', glow: 'rgba(48, 209, 88, 0.4)', soft: 'rgba(48, 209, 88, 0.16)' },
  { accent: '#ff9f0a', glow: 'rgba(255, 159, 10, 0.4)', soft: 'rgba(255, 159, 10, 0.16)' },
  { accent: '#ff375f', glow: 'rgba(255, 55, 95, 0.4)', soft: 'rgba(255, 55, 95, 0.16)' },
  { accent: '#64d2ff', glow: 'rgba(100, 210, 255, 0.4)', soft: 'rgba(100, 210, 255, 0.16)' },
  { accent: '#63e6e0', glow: 'rgba(99, 230, 224, 0.4)', soft: 'rgba(99, 230, 224, 0.16)' },
  { accent: '#ff9500', glow: 'rgba(255, 149, 0, 0.4)', soft: 'rgba(255, 149, 0, 0.16)' },
];
