import { state } from '../state.js';
import { STORAGE_KEY_CACHE_TIME, STORAGE_KEY_THEME, THEMES } from '../constants.js';
import { applyOptions } from '../options.js';
import { openAssignmentModal } from '../components/assignment-modal.js';
import { openShortcutsModal } from '../components/shortcuts-modal.js';
import { toggleCampusToolsModal } from '../components/campus-tools-modal.js';
import { initKeyboardShortcuts } from '../handlers/keyboard-shortcuts.js';
import { deduplicateCourseMap, loadTasks, refreshAnnouncementsOnly } from '../services/task-loader.js';
import { loadCoursePercentagesCache, loadLocalAnnouncementsCache, loadLocalAnnouncementsCacheTime, loadLocalCache, loadLocalGradesCache } from '../storage/caches.js';
import { autoCompleteSubmittedTasks } from '../storage/completed-tasks.js';
import { mergeCustomTasksIntoCourseMap } from '../storage/custom-assignments.js';
import { applyCustomDueDates } from '../storage/custom-due-dates.js';
import { getHiddenCourses, unhideCourse } from '../storage/hidden-courses.js';
import { scrapeCanvasDashboardColors } from '../utils/colors.js';
import { escapeHTML } from '../utils/text.js';
import { hydrateSyncedStorage } from '../storage/xstorage.js';
import { showReloadProgress } from './reload-progress.js';
import { initNotesPopover } from './notes-popover.js';
import { markAnnouncementsSeen, updateAnnouncementBadge } from '../views/announcements-view.js';
import { renderCurrentView, renderFilterPills, renderWorkloadStrip, updateProgressBar } from '../views/upcoming-view.js';
import { refreshDashboardView } from '../views/dashboard-view.js';
import { maybeShowWhatsNewBanner } from './whats-new-banner.js';
import { updateBellBadge } from '../views/notifications-view.js';

// News (announcements) have their own freshness window — the background
// rescans deliberately skip them, so this drives a cheap standalone refresh
// that keeps the News column current without a full rescan.
const ANNOUNCEMENTS_FRESH_MS = 5 * 60 * 1000;

export function purgeDefaultCanvasElements() {
    const selectors = [
      '#right-side .todo-list-needed',
      '#right-side .to-do-list',
      '#right-side .events_list',
      '#right-side .recent_feedback',
      '.Sidebar__TodoListContainer',
      '.ic-sidebar-right__event-list'
    ];
    document.querySelectorAll(selectors.join(',')).forEach(el => el.remove());

    const rightSide = document.getElementById('right-side');
    if (rightSide) {
      Array.from(rightSide.children).forEach(child => {
        if (child.id !== 'module-tasks-widget' && child.id !== 'hidden-courses-popover') {
          const text = child.innerText || '';
          if (/to-?\s*do|recent feedback|coming up/i.test(text)) {
            child.remove();
          }
        }
      });
    }
  }

// The widget has no sidebar or minimize-to-edge mode anymore: fullscreen is
// the only thing. This relocates the widget to <body> (the
// #right-side-wrapper `container-type` would otherwise make it a containing
// block for the `position: fixed` fullscreen shell, pinning it to that small
// box), applies the fullscreen shell class, and performs the first render.
// A hidden placeholder marks the original injection point.
function prepFullscreenShell() {
    state.isFullscreen = true;

    const widget = document.getElementById('module-tasks-widget');
    if (!widget) return;

    let placeholder = document.getElementById('yace-widget-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.id = 'yace-widget-placeholder';
      placeholder.style.display = 'none';
      widget.parentNode.insertBefore(placeholder, widget);
    }
    document.body.appendChild(widget);

    widget.classList.add('is-fullscreen');
    document.body.classList.add('yace-fullscreen-active');
  }

export function setWidgetFullscreen() {
    prepFullscreenShell();
    renderCurrentView();
  }

export async function injectWidget(container) {
    // The skeleton mounts SYNCHRONOUSLY — prepend + fullscreen shell classes
    // happen before any await, so Canvas's own chrome can never flash behind
    // the widget. Cross-origin state is then hydrated (best-effort, capped at
    // 1s) so the FIRST data render opens with the sibling origin's saved
    // panel state, hidden courses, custom due dates and task cache — and even
    // if the storage backend hangs, the dashboard still renders after the cap.
    const nowDate = new Date();
    const dayNum = nowDate.getDate();
    const suffix = (dayNum % 10 === 1 && dayNum !== 11) ? 'st' : (dayNum % 10 === 2 && dayNum !== 12) ? 'nd' : (dayNum % 10 === 3 && dayNum !== 13) ? 'rd' : 'th';
    const todayFormatted = `${nowDate.toLocaleDateString(undefined, { weekday: 'long' })} ${nowDate.toLocaleDateString(undefined, { month: 'long' })} ${dayNum}${suffix}, ${nowDate.getFullYear()}`;

    const widget = document.createElement('div');
    widget.id = 'module-tasks-widget';
    widget.setAttribute('data-theme', state.currentTheme);
    widget.innerHTML = `
    <div class="header">
    <div class="title-row">
    <span class="title">YACE</span>
    </div>
    <div class="widget-date-center">
    <span class="widget-current-date">${todayFormatted}</span>
    </div>
    <div class="widget-controls">
    <button type="button" class="icon-btn campus-tools-btn" data-tool="food" title="Campus Dining Hall Menus" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🍽</span><span class="campus-tools-label">Food</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="rmp" title="Rate My Professors" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🧑‍🏫</span><span class="campus-tools-label">Prof</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="registration" title="WebCat Registration" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🎓</span><span class="campus-tools-label">Reg</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="buildings" title="Building Hours — MUB, Rec, Library" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🏢</span><span class="campus-tools-label">Hours</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="days" title="Days Off — UNH holidays, breaks &amp; closures" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🌴</span><span class="campus-tools-label">Days Off</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="export" title="Export Assignments as .ics Calendar" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">📅</span><span class="campus-tools-label">Export</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="options" title="Options — theme, tabs, notifications" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">⚙️</span><span class="campus-tools-label">Options</span>
    </button>
    <button type="button" class="icon-btn notes-btn" id="toggle-notes-btn" title="Sticky Notes" aria-haspopup="dialog" aria-expanded="false">
    <svg class="notes-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>
    <span class="campus-tools-label">Notes</span>
    </button>
    <button type="button" class="icon-btn campus-tools-btn" data-tool="notifications" title="Recent Notifications" aria-haspopup="dialog" aria-expanded="false">
    <span class="campus-tools-icon">🔔</span><span class="campus-tools-label">Alerts</span>
    <span class="bell-badge" id="bell-badge" style="display:none;"></span>
    </button>
    <button class="icon-btn" id="toggle-shortcuts-btn" title="View Keyboard Shortcuts">⌨</button>

    <!-- Theme Swatch Palette Dock -->
    <div class="theme-dock-wrap" id="theme-dock-wrap">
    <button type="button" class="icon-btn theme-dock-trigger" id="theme-dock-trigger" title="Switch Theme" aria-haspopup="listbox" aria-expanded="false">
    <span class="theme-trigger-swatch" id="theme-trigger-swatch" style="--gem-color: ${THEMES.find(t => t.id === state.currentTheme)?.color || THEMES[0].color};"></span>
    <span class="theme-trigger-caret">▾</span>
    </button>
    <div class="theme-dock-flyout" id="theme-dock-flyout" role="listbox">
    ${THEMES.map(t => `
      <button type="button" class="theme-option-btn ${state.currentTheme === t.id ? 'active' : ''}" data-theme="${t.id}" role="option" aria-selected="${state.currentTheme === t.id}">
      <span class="theme-option-swatch" style="--gem-color: ${t.color};"></span>
      <span class="theme-option-label">${escapeHTML(t.label)}</span>
      <span class="theme-option-check">✓</span>
      </button>
    `).join('')}
    </div>
    </div>

    <button class="icon-btn eye-btn" id="toggle-hidden-courses-btn" title="View Hidden Classes">👁<span class="eye-badge" id="eye-badge" style="display:none;"></span></button>
    <button class="icon-btn" id="refresh-mod-tasks" title="Reload Everything">↻</button>
    </div>    </div>

    <div class="hidden-courses-popover" id="hidden-courses-popover">
    <div class="hidden-popover-header">
    <span class="hidden-popover-title">Hidden Classes</span>
    <button class="hidden-popover-close" id="close-hidden-courses-btn" title="Close">✕</button>
    </div>
    <div class="hidden-pills-list" id="hidden-pills-container"></div>
    </div>

    <div class="notes-popover" id="notes-popover">
    <div class="notes-popover-header">
    <span class="notes-popover-title">📝 Sticky Notes</span>
    <button type="button" class="notes-add-btn" title="New note">＋ New</button>
    <button type="button" class="notes-popover-close" title="Close">✕</button>
    </div>
    <div class="notes-list" id="notes-list"></div>
    <p class="notes-empty" id="notes-empty">Nothing here yet — hit ＋ New to jot something down.</p>
    </div>

    <div class="workload-strip" id="workload-strip-container"></div>

    <!-- Compact Unified Search, Course Filter & Horizon Scope -->
    <div class="search-bar-row">
    <div class="course-filter-dropdown-wrap">
    <button type="button" class="course-filter-btn" id="course-filter-btn" title="Filter by Class">
    <span id="course-filter-label">All</span>
    <span class="course-filter-caret">▾</span>
    </button>
    <div class="course-filter-menu" id="course-filter-menu"></div>
    </div>

    <div class="search-wrapper">
    <input type="text" class="search-input" id="task-search-input" placeholder="Search (/)..." />
    </div>

    <div class="radial-horizon-wrap" id="radial-horizon-wrap">
    <button type="button" class="radial-horizon-trigger" id="radial-horizon-trigger" title="Hover to choose horizon">
    <span id="radial-horizon-label">2W</span>
    </button>
    <div class="radial-pie-menu">
    <button type="button" class="pie-slice" data-range="today" style="--slice-index: 0;" title="1 Day (Today)"><span>1D</span></button>
    <button type="button" class="pie-slice" data-range="week" style="--slice-index: 1;" title="1 Week"><span>1W</span></button>
    <button type="button" class="pie-slice active" data-range="2weeks" style="--slice-index: 2;" title="2 Weeks"><span>2W</span></button>
    <button type="button" class="pie-slice" data-range="month" style="--slice-index: 3;" title="1 Month"><span>1M</span></button>
    <button type="button" class="pie-slice" data-range="all" style="--slice-index: 4;" title="All Horizons"><span>∞</span></button>
    </div>
    </div>
    </div>

    <div class="progress-container">
    <div class="progress-meta">
    <span id="progress-label">0% this week</span>
    <span id="progress-count">0/0 this week</span>
    </div>
    <div class="progress-bar-bg">
    <div class="progress-bar-fill tier-low" id="progress-bar-fill"></div>
    </div>
    </div>

    <!-- View Tabs + Add Task Bar -->
    <div class="hud-command-bar">
    <div class="hud-view-buttons">
    <button type="button" class="hud-view-btn active" data-tab="upcoming">Due</button>
    <button type="button" class="hud-view-btn" data-tab="overdue">Overdue <span class="hud-tab-badge" id="hud-overdue-badge" style="display:none;"></span><span id="overdue-total-badge" style="display:none;"></span></button>
    <button type="button" class="hud-view-btn" data-tab="completed">Done</button>
    <button type="button" class="hud-view-btn" data-tab="grades">Grades <span class="hud-tab-badge grades-change-badge" id="grades-change-badge" style="display:none;"></span></button>
    <button type="button" class="hud-view-btn" data-tab="general">Info</button>
    <button type="button" class="hud-view-btn" data-tab="announcements">News <span class="hud-tab-badge announce-dot" id="announce-badge" style="display:none;"></span></button>
    <button type="button" class="hud-view-btn" data-tab="schedule">Schedule</button>
    </div>    <button type="button" class="hud-add-btn" id="add-custom-task-btn" title="Create Custom Assignment (Press 'n')">
    <span class="plus-icon">＋</span> <span class="btn-text">Task</span>
    </button>
    </div>

    <div id="module-tasks-list">
    <div class="mod-empty-msg">Scanning Canvas & Gradescope...</div>
    </div>    `;

    container.prepend(widget);

// Apply persisted options (hidden view tabs, notification prefs) to the
    // widget right after it's in the DOM, before the first render kicks off.
    applyOptions();

    // Fullscreen shell chrome NOW, before any async work — the widget must
    // cover the page the same frame it appears (see prepFullscreenShell).
    // prepFullscreenShell() is idempotent, so setWidgetFullscreen() below
    // re-applies it right before the first render.
    prepFullscreenShell();

    // Cross-origin storage seed (see storage/xstorage.js). Raced against a
    // 1s timeout so a hung storage backend can never gate the first render —
    // worst case the dashboard opens with this origin's localStorage only.
    try {
      await Promise.race([
        hydrateSyncedStorage(),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    } catch (err) {
      console.warn('[YACE] storage hydrate failed:', err);
    }

    // FIRST RENDER — the instant skeleton + any cross-origin cache the seed
    // just made visible. A render failure must surface visibly, never as an
    // endless "Scanning…" dead end with no dock and a dead ↻.
    try {
      setWidgetFullscreen();
    } catch (err) {
      console.error('[YACE] initial render failed:', err);
      const list = document.getElementById('module-tasks-list');
      if (list && !list.querySelector('.fullscreen-dashboard')) {
        list.innerHTML = `<div class="mod-empty-msg" style="color:#f87171; white-space:pre-wrap;">YACE failed to render — see console.\n${String(err && err.message || err)}</div>`;
      }
    }

    // The widget covers the entire viewport in fullscreen, so a mousemove
    // handler here used to run on every mouse event on the page: forced layout
    // (getBoundingClientRect) + two setProperty calls that invalidated style
    // for the whole tree + a full-screen radial-gradient repaint under
    // mix-blend-mode. Removed deliberately — see the note where
    // #module-tasks-widget::after used to live in widget-shell.css.

    document.getElementById('toggle-shortcuts-btn').addEventListener('click', openShortcutsModal);
    // Each header tool button deep-links to its own tab in the Campus & Tools
    // overlay (Food / Professors / WebCat Reg).
    document.querySelectorAll('.campus-tools-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleCampusToolsModal(btn.getAttribute('data-tool')));
    });
    document.getElementById('add-custom-task-btn').addEventListener('click', () => openAssignmentModal());
    const courseScrollWrap = widget.querySelector('.course-scroll-wrap');
    if (courseScrollWrap) {
      courseScrollWrap.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          courseScrollWrap.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }
    const radialLabel = document.getElementById('radial-horizon-label');
    const radialWrap = document.getElementById('radial-horizon-wrap');
    const rangeLabels = {
      today: '1D',
      week: '1W',
      '2weeks': '2W',
      month: '1M',
      all: '∞'
    };

    if (radialWrap) {
      radialWrap.addEventListener('mouseleave', () => {
        radialWrap.classList.remove('is-closed');
      });
    }

    widget.querySelectorAll('.pie-slice').forEach(slice => {
      slice.addEventListener('click', (e) => {
        e.stopPropagation();
        widget.querySelectorAll('.pie-slice').forEach(s => s.classList.remove('active'));
        slice.classList.add('active');
        state.assignmentRangeFilter = slice.getAttribute('data-range');
        if (radialLabel) radialLabel.textContent = rangeLabels[state.assignmentRangeFilter] || '2W';

        // Immediately dismiss the menu
        if (radialWrap) radialWrap.classList.add('is-closed');

        renderCurrentView();
      });
    });    const themeDockWrap = document.getElementById('theme-dock-wrap');
    const themeDockTrigger = document.getElementById('theme-dock-trigger');
    // In fullscreen the .widget-controls strip is a horizontal scroll
    // container (overflow-x: auto), which clips the absolutely-positioned
    // flyout. Relax the strip's overflow while the dock is open so the
    // dropdown is visible; closing restores narrow-window scrolling.
    const themeDockControls = themeDockWrap ? themeDockWrap.parentElement : null;

    // Click toggle so it stays open reliably without relying solely on hover
    if (themeDockTrigger && themeDockWrap) {
      themeDockTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowOpen = themeDockWrap.classList.toggle('is-open');
        themeDockTrigger.setAttribute('aria-expanded', String(nowOpen));
        if (themeDockControls) themeDockControls.classList.toggle('is-overflow-open', nowOpen);
      });

      document.addEventListener('click', () => {
        themeDockWrap.classList.remove('is-open');
        themeDockTrigger.setAttribute('aria-expanded', 'false');
        if (themeDockControls) themeDockControls.classList.remove('is-overflow-open');
      });
    }

    widget.querySelectorAll('.theme-option-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selectedTheme = btn.getAttribute('data-theme');
        if (!selectedTheme) return;

        state.currentTheme = selectedTheme;
        localStorage.setItem(STORAGE_KEY_THEME, state.currentTheme);
        widget.setAttribute('data-theme', state.currentTheme);

        const modal = document.getElementById('yace-assignment-modal');
        if (modal) modal.setAttribute('data-theme', state.currentTheme);

        widget.querySelectorAll('.theme-option-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        const themeMeta = THEMES.find(t => t.id === selectedTheme);
        const swatch = document.getElementById('theme-trigger-swatch');
        if (swatch && themeMeta) swatch.style.setProperty('--gem-color', themeMeta.color);

        // Close dock once picked
        if (themeDockWrap) themeDockWrap.classList.remove('is-open');
        if (themeDockTrigger) themeDockTrigger.setAttribute('aria-expanded', 'false');
        if (themeDockControls) themeDockControls.classList.remove('is-overflow-open');
      });
    });

    document.getElementById('refresh-mod-tasks').addEventListener('click', () => {
      scrapeCanvasDashboardColors();
      // Visible feedback immediately, even when this is a minutes-long scan:
      // the overlay appears now, not only after the first API response.
      showReloadProgress('Reloading everything...', 3);
      loadTasks(true);
    });
    const eyeBtn = document.getElementById('toggle-hidden-courses-btn');
    const closeBtn = document.getElementById('close-hidden-courses-btn');

    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.isHiddenMenuOpen = !state.isHiddenMenuOpen;
      updateHiddenMenuButton();
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.isHiddenMenuOpen = false;
      updateHiddenMenuButton();
    });

    // Debounce the re-render: state.searchQuery updates on every keystroke
    // (so anything reading it stays current), but the full dashboard rebuild
    // waits ~180ms — typing a query used to do one full rebuild PER KEYSTROKE.
    const searchInput = document.getElementById('task-search-input');
    let searchRenderTimer = null;
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      clearTimeout(searchRenderTimer);
      searchRenderTimer = setTimeout(() => renderCurrentView(), 180);
    });

    widget.querySelectorAll('.hud-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        widget.querySelectorAll('.hud-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentTab = btn.getAttribute('data-tab');
        state.activeDayFilter = null;
        if (state.currentTab === 'announcements') {
          markAnnouncementsSeen();
          updateAnnouncementBadge();
        }
        renderCurrentView();
      });
    });      // Throttle bookkeeping for the 30s poll: the assignments-list
      // rebuild is capped at once per 5 minutes, and a background rescan
      // started by the poll must not stack with a previous one.
      let lastListRefresh = 0;
      let backgroundScanInFlight = false;
      let announceRefreshInFlight = false;
      // Load-time assignment scans (see the cache render path below) run on
      // every page load but are throttled so quick page-to-page navigation
      // can't stack several heavy scans back to back.
      let lastLoadScanAt = 0;
      const pollTick = () => {
        // A hidden tab paints nothing, so every write below is pure waste —
        // and the background rescan is ~50-200 network requests. Skip the tick
        // entirely and let visibilitychange run it once on the way back.
        if (document.hidden) return;
        if (document.getElementById('module-tasks-widget')) {
          updateProgressBar();
          // Rebuilding the assignments list every 30s stacked duplicate
          // cards, so it's throttled to once per 5 minutes (same window as
          // the cache freshness check below).
          const now = Date.now();
          if (now - lastListRefresh >= 5 * 60 * 1000) {
            lastListRefresh = now;
            refreshDashboardView();
          }
          // A long-running scan must not look dead — surface progress +
          // elapsed time so a hung API call is at least visible, not an
          // eternal "Scanning…" with no way to tell what's happening.
          if (state.isScanning && state.scanStartedAt && now - state.scanStartedAt > 8 * 60 * 1000) {
            const mins = Math.round((now - state.scanStartedAt) / 60000);
            showReloadProgress(`Scan still running (${mins} min elapsed)...`, 50);
          }
          // When the 5-minute cache window lapses, kick a background rescan
          // of assignments + grades + announcements. Guarded so two poll
          // ticks can't stack scans.
          const lastCacheTime = parseInt(localStorage.getItem(STORAGE_KEY_CACHE_TIME) || '0', 10);
          if (now - lastCacheTime >= 5 * 60 * 1000 && !backgroundScanInFlight) {
            backgroundScanInFlight = true;
            loadTasks(false).finally(() => {
              backgroundScanInFlight = false;
            });
          }
          // News gets an extra dedicated refresh on its own window — the
          // scans above already include announcements, but this fast-path
          // keeps the News column current even while a full scan is in
          // flight (5 minutes in the poll; every page load).
          if (now - loadLocalAnnouncementsCacheTime() >= ANNOUNCEMENTS_FRESH_MS && !announceRefreshInFlight) {
            announceRefreshInFlight = true;
            refreshAnnouncementsOnly().finally(() => {
              announceRefreshInFlight = false;
            });
          }
        }
      };
      setInterval(pollTick, 30000);

      // Tab-visibility switch. `yace-tab-hidden` pauses every CSS animation
      // under the YACE roots (tokens.css MOTION POLICY) — the infinite
      // shimmer/pulse loops repaint at display refresh rate forever otherwise,
      // which is what pinned the CPU/GPU awake with the tab in the background.
      // Coming back runs one poll tick immediately rather than waiting out the
      // 30s interval.
      document.addEventListener('visibilitychange', () => {
        document.documentElement.classList.toggle('yace-tab-hidden', document.hidden);
        if (!document.hidden) pollTick();
      });
      // In case the tab was already hidden when the widget mounted.
      document.documentElement.classList.toggle('yace-tab-hidden', document.hidden);

      const cachedGradesLocal = loadLocalGradesCache();
      if (cachedGradesLocal) {
        state.cachedGrades = cachedGradesLocal;
      }
      state.cachedCoursePercentages = loadCoursePercentagesCache();

      const cachedAnnouncementsLocal = loadLocalAnnouncementsCache();
      if (cachedAnnouncementsLocal) {
        state.cachedAnnouncements = cachedAnnouncementsLocal;
      }
      updateAnnouncementBadge();

      const cached = loadLocalCache();
      const lastCacheTime = parseInt(localStorage.getItem(STORAGE_KEY_CACHE_TIME) || '0', 10);
      const isCacheFresh = (Date.now() - lastCacheTime) < (5 * 60 * 1000);
      console.info('YACE cache', {
        hasCache: !!cached,
        courseCount: cached ? Object.keys(cached).length : 0,
        fresh: isCacheFresh,
        ageMin: Math.round((Date.now() - lastCacheTime) / 60000),
      });

      try {
        if (cached && Object.keys(cached).length > 0) {
          state.cachedCourseMap = deduplicateCourseMap(cached, state.cachedGrades);
          applyCustomDueDates();
          autoCompleteSubmittedTasks(state.cachedCourseMap);
          mergeCustomTasksIntoCourseMap(state.cachedCourseMap);
          renderFilterPills();
          updateHiddenMenuButton();
          updateProgressBar();
          renderWorkloadStrip();
          renderCurrentView();

          // Recheck for new/changed assignments on every page load, not just
          // after the 5-minute cache lapses — the UI already rendered from
          // cache above, so this runs quietly in the background and updates
          // panels when it finishes. Throttled + in-flight-guarded.
          // Announcements are included so the News column never goes stale.
          if (Date.now() - lastLoadScanAt >= 3 * 60 * 1000 && !backgroundScanInFlight) {
            lastLoadScanAt = Date.now();
            backgroundScanInFlight = true;
            loadTasks(false).finally(() => {
              backgroundScanInFlight = false;
            });
          }
        } else {
          loadTasks(true);
        }
      } catch (cacheErr) {
        // A cached render must never wedge the widget into a blank state —
        // log the real cause and fall back to a full fresh scan.
        console.error('YACE cached render failed, scanning fresh:', cacheErr);
        state.cachedCourseMap = {};
        loadTasks(true);
      }

      // Keep News fresh on every page load — the standalone refresh fetches
      // its own live course list + per-course announcements (no dependency on
      // the cache render above) and self-throttles to once a minute, so rapid
      // reloads can't spam the APIs.
      refreshAnnouncementsOnly();

      initKeyboardShortcuts();
      initNotesPopover();
      maybeShowWhatsNewBanner();
      updateBellBadge();
  }

export function updateHiddenMenuButton() {
    const eyeBtn = document.getElementById('toggle-hidden-courses-btn');
    const eyeBadge = document.getElementById('eye-badge');
    const popover = document.getElementById('hidden-courses-popover');
    const container = document.getElementById('hidden-pills-container');
    const hidden = getHiddenCourses();

    if (!eyeBtn || !popover || !container) return;

    if (hidden.length > 0) {
      eyeBtn.classList.add('has-hidden');
      if (eyeBadge) eyeBadge.style.display = 'block';
    } else {
      eyeBtn.classList.remove('has-hidden');
      if (eyeBadge) eyeBadge.style.display = 'none';
      state.isHiddenMenuOpen = false;
    }

    if (state.isHiddenMenuOpen && hidden.length > 0) {
      eyeBtn.classList.add('active');
      popover.classList.add('is-visible');
      container.innerHTML = '';
      hidden.forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'hidden-pill-btn';
        btn.innerHTML = `<span>+</span> ${escapeHTML(k)}`;
        btn.title = `Click to restore ${escapeHTML(k)}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          unhideCourse(k);
        });
        container.appendChild(btn);
      });
    } else {
      eyeBtn.classList.remove('active');
      popover.classList.remove('is-visible');
    }
  }
