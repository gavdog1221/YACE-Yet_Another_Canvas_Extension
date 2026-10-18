// The Tests tab: a mini calendar of tests/quizzes that are NOT already in
// the assignments list. Two sources, both zero extra network requests:
//   1. Syllabus exam dates — parsed from each course's syllabus body during
//      the regular scan (extractExamDates in utils/text.js; PDF-only
//      syllabi get them from the weight-backfill's existing PDF text pass)
//      and stored on course.resources.examDates.
//   2. Custom tests — entries the user adds when a prof announces one in
//      class (components/test-modal.js → storage/custom-tests.js).
// A syllabus exam is dropped when the same course already has a test-like
// assignment OR a custom test on that date (those surfaces own it), so this
// tab never duplicates the Due list. The examDates field is absent from
// pre-existing task caches and self-heals on the next page-load scan (no
// storage-key bump — same precedent as the lateDate roll-over field).
//
// Layout mirrors the Due tab's chrome: the 7-day ribbon on top (same
// markup/classes, tests-only counts, click filters this list), cards grouped
// per day below, TBA items in their own "No date set" group. Past-dated
// entries drop off (there is no Overdue equivalent here — the exam happened).

import { state } from '../state.js';
import { getCustomTests, deleteCustomTest } from '../storage/custom-tests.js';
import { openTestModal } from '../components/test-modal.js';
import { getHiddenCourses } from '../storage/hidden-courses.js';
import { getCourseColors } from '../utils/colors.js';
import { localDateKey } from '../utils/dates.js';
import { escapeHTML, isTestLike } from '../utils/text.js';
import { renderWorkloadStrip, updateTestsTabBadge } from './upcoming-view.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// 'YYYY-MM-DD' → local midnight Date (never new Date(string): that parses
// as UTC and shifts a day in negative offsets), or null for TBA/invalid.
function dateFromKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return isNaN(date.getTime()) ? null : date;
  }

// Every calendar entry for the visible course set as
// { id, title, courseKey, courseName, dateKey, date, source, excerpt, url }.
// Custom tests come first (they always win a course+day slot), then syllabus
// exams deduped against custom tests, syllabus repeats, and test-like
// assignments on the same course+day. Honors the course pill and search box.
function collectTestEntries(hiddenCourses, honorSearch = true) {
    const entries = [];
    const takenKeys = new Set();   // `${courseKey}|${dateKey}` — owned slots

    getCustomTests().forEach((t) => {
      if (t.courseKey && hiddenCourses.includes(t.courseKey)) return;
      if (state.activeCourseFilter !== 'ALL' && t.courseKey && state.activeCourseFilter !== t.courseKey) return;
      if (honorSearch && state.searchQuery && !t.title.toLowerCase().includes(state.searchQuery)) return;
      if (t.dateKey) takenKeys.add(`${t.courseKey}|${t.dateKey}`);
      const course = state.cachedCourseMap[t.courseKey] || {};
      entries.push({
        id: `custom:${t.id}`,
        customId: t.id,
        title: t.title,
        courseKey: t.courseKey,
        courseName: t.courseKey ? (course.name || t.courseKey) : '',
        dateKey: t.dateKey || null,
        date: dateFromKey(t.dateKey),
        source: 'custom',
      });
    });

    // Course+day slots already owned by a test-like Canvas/Gradescope
    // assignment — the Due tab lists those, so the syllabus copy is a dup.
    const taskKeys = new Set();
    Object.keys(state.cachedCourseMap).forEach((courseKey) => {
      if (hiddenCourses.includes(courseKey)) return;
      if (state.activeCourseFilter !== 'ALL' && state.activeCourseFilter !== courseKey) return;
      ((state.cachedCourseMap[courseKey].tasks) || []).forEach((t) => {
        if (!t || !t.dueDate || !isTestLike(t)) return;
        taskKeys.add(`${courseKey}|${localDateKey(t.dueDate)}`);
      });
    });

    Object.keys(state.cachedCourseMap).forEach((courseKey) => {
      if (hiddenCourses.includes(courseKey)) return;
      if (state.activeCourseFilter !== 'ALL' && state.activeCourseFilter !== courseKey) return;
      const course = state.cachedCourseMap[courseKey];
      const exams = (course.resources && course.resources.examDates) || [];
      exams.forEach((exam, i) => {
        if (!exam || !exam.title) return;
        const dateKey = exam.dateKey || null;
        if (dateKey) {
          const slot = `${courseKey}|${dateKey}`;
          if (takenKeys.has(slot) || taskKeys.has(slot)) return;
          takenKeys.add(slot);  // also dedupes repeated syllabus mentions
        }
        if (honorSearch && state.searchQuery && !exam.title.toLowerCase().includes(state.searchQuery)) return;
        entries.push({
          id: `exam:${courseKey}:${dateKey || 'tba'}:${i}`,
          title: exam.title,
          courseKey,
          courseName: course.name || courseKey,
          canvasCourseId: course.canvasCourseId || null,
          dateKey,
          date: dateFromKey(dateKey),
          source: 'syllabus',
          excerpt: exam.excerpt || '',
          url: (course.resources && course.resources.syllabusUrl) || '',
        });
      });
    });
    return entries;
  }

// Tab badge + fullscreen panel badge: exams/tests landing in the next 7 days.
// All local (syllabus exams ride in on the regular scan) — safe to call on
// every render.
export function countUpcomingTests() {
    const todayKey = localDateKey(new Date());
    const endKey = localDateKey(new Date(Date.now() + 7 * DAY_MS));
    return collectTestEntries(getHiddenCourses(), false)
      .filter((e) => e.dateKey && e.dateKey >= todayKey && e.dateKey <= endKey)
      .length;
  }

// Keep the HUD tab badge and the fullscreen panel badge honest after the
// calendar changes (mirrors the overdue-badge sync in dashboard-view.js).
function refreshTestBadges() {
    updateTestsTabBadge();
    const panel = document.querySelector('.tests-panel');
    if (!panel) return;
    const soon = countUpcomingTests();
    const badge = panel.querySelector('.fullscreen-panel-badge');
    if (badge) badge.textContent = soon > 0 ? String(soon) : '';
    else if (soon > 0) {
      const b = document.createElement('span');
      b.className = 'fullscreen-panel-badge is-tests';
      b.textContent = String(soon);
      const header = panel.querySelector('.fullscreen-panel-header');
      const toggle = header && header.querySelector('.panel-collapse-btn');
      if (header) header.insertBefore(b, toggle);
      else if (panel.querySelector('.fullscreen-panel-title')) panel.querySelector('.fullscreen-panel-title').after(b);
    }
  }

// Tests-only mirror of the 7-day workload ribbon (renderWorkloadStrip): same
// classes/markup, but the counts are tests per day and a click filters THIS
// view's list (state.activeDayFilter) instead of jumping to the Due tab.
// No leakage: clicking any HUD tab clears activeDayFilter anyway.
function renderTestsStrip(container, entries, now) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      let label = d.toLocaleDateString([], { weekday: 'short' });
      if (i === 0) label = 'Today';
      else if (i === 1) label = 'Tmrw';
      days.push({ dateKey: localDateKey(d), label: label, isUrgent: i <= 1, count: 0 });
    }
    const byKey = new Map(days.map((d) => [d.dateKey, d]));
    entries.forEach((e) => {
      const day = e.dateKey ? byKey.get(e.dateKey) : null;
      if (day) day.count++;
    });

    const strip = document.createElement('div');
    strip.className = 'workload-strip tests-strip';
    days.forEach((day) => {
      const dayEl = document.createElement('div');
      dayEl.className = `workload-day ${day.count > 0 ? 'has-tasks' : ''} ${day.isUrgent && day.count > 0 ? 'has-urgent' : ''} ${state.activeDayFilter === day.dateKey ? 'active' : ''}`;
      dayEl.innerHTML = `
      <span class="day-name">${day.label}</span>
      <span class="day-count">${day.count}</span>
      `;
      dayEl.addEventListener('click', () => {
        state.activeDayFilter = state.activeDayFilter === day.dateKey ? null : day.dateKey;
        renderWorkloadStrip();       // keep the Due ribbon's day highlight in sync
        // Re-render THIS container instead of renderCurrentView(): in fullscreen
        // the Tests panel is a scrape panel that gets re-mounted as-is on
        // interactive re-renders (only loadTasks rebuilds it), so a full
        // re-render would leave the click visibly unapplied.
        renderTestsView(container);
      });
      strip.appendChild(dayEl);
    });
    container.appendChild(strip);
  }

// Group header: "Today" / "Tomorrow" / "Thu Oct 22", countdown right-aligned.
function makeDayHeader(date, startOfToday) {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayIndex = Math.round((dayStart - startOfToday) / DAY_MS);
    const title = dayIndex === 0
      ? 'Today'
      : dayIndex === 1
        ? 'Tomorrow'
        : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const countdown = dayIndex <= 1 ? '' : `in ${dayIndex} days`;
    const header = document.createElement('div');
    header.className = `tests-day-header${dayIndex === 0 ? ' is-today' : ''}`;
    header.innerHTML = `
    <span class="tests-day-name">${escapeHTML(title)}</span>
    <span class="tests-day-countdown">${escapeHTML(countdown)}</span>
    `;
    return header;
  }

// One calendar row: course dot + title (+ course name), a source tag, and a
// delete button on custom entries. Syllabus rows open the syllabus page on
// click (the tooltip quotes the sentence the date was parsed from).
function makeEntryCard(entry, container) {
    const card = document.createElement('div');
    card.className = `tests-entry ${entry.source === 'custom' ? 'is-custom' : 'is-syllabus'}`;
    const palette = getCourseColors(entry.courseKey, entry.canvasCourseId);
    card.style.setProperty('--task-course-accent', palette.accent);
    card.style.setProperty('--task-course-glow', palette.glow);
    const tag = entry.source === 'custom' ? 'Custom' : 'Syllabus';
    card.innerHTML = `
    <span class="tests-entry-dot"></span>
    <span class="tests-entry-main">
    <span class="tests-entry-title">${escapeHTML(entry.title)}</span>
    ${entry.courseName ? `<span class="tests-entry-course">${escapeHTML(entry.courseName)}</span>` : ''}
    </span>
    <span class="tests-entry-tag">${tag}</span>
    ${entry.source === 'custom' ? '<button type="button" class="tests-entry-delete" title="Remove">✕</button>' : ''}
    `;
    if (entry.source === 'syllabus' && entry.url) {
      card.classList.add('is-link');
      card.title = entry.excerpt
        ? `From the syllabus: “${entry.excerpt}” — click to open it`
        : 'From the syllabus — click to open it';
      card.addEventListener('click', () => window.open(entry.url, '_blank'));
    } else if (entry.excerpt) {
      card.title = `From the syllabus: “${entry.excerpt}”`;
    } else {
      card.title = 'Added by you';
    }
    const del = card.querySelector('.tests-entry-delete');
    if (del) {
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteCustomTest(entry.customId);
        refreshTestBadges();
        renderTestsView(container);
      });
    }
    return card;
  }

export function renderTestsView(container) {
    container.innerHTML = '';
    const hiddenCourses = getHiddenCourses();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayKey = localDateKey(startOfToday);
    const dayFilter = state.activeDayFilter;

    // "+ Test" toolbar — sits above the strip so it reads as part of the
    // calendar chrome, not as a list item.
    const toolbar = document.createElement('div');
    toolbar.className = 'tests-toolbar';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'hud-add-btn tests-add-btn';
    addBtn.innerHTML = '<span class="plus-icon">＋</span> <span class="btn-text">Test</span>';
    addBtn.title = 'Add a test or quiz a prof announced';
    addBtn.addEventListener('click', () => {
      openTestModal(() => {
        refreshTestBadges();
        renderTestsView(container);
      });
    });
    toolbar.appendChild(addBtn);
    container.appendChild(toolbar);

    const allEntries = collectTestEntries(hiddenCourses);
    // Past-dated exams drop off the calendar — no Overdue equivalent here.
    const upcoming = allEntries.filter((e) => !e.dateKey || e.dateKey >= todayKey);

    renderTestsStrip(container, upcoming, now);

    let entries = upcoming;
    // TBA items belong to no day; a day filter hides them.
    if (dayFilter) entries = entries.filter((e) => e.dateKey === dayFilter);
    entries = entries.slice().sort((a, b) => {
      if (a.dateKey && b.dateKey) return a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0;
      return a.dateKey ? -1 : b.dateKey ? 1 : 0;
    });

    let renderedCount = 0;
    let lastKey = null;
    let undatedDone = false;
    entries.forEach((e) => {
      if (!e.dateKey) {
        if (undatedDone) return;
        undatedDone = true;
        const header = document.createElement('div');
        header.className = 'tests-day-header';
        header.innerHTML = `
        <span class="tests-day-name">No date set</span>
        <span class="tests-day-countdown">unscheduled</span>
        `;
        container.appendChild(header);
      } else if (e.dateKey !== lastKey) {
        lastKey = e.dateKey;
        container.appendChild(makeDayHeader(e.date, startOfToday));
      }
      container.appendChild(makeEntryCard(e, container));
      renderedCount++;
    });

    if (renderedCount === 0) {
      const empty = document.createElement('div');
      if (dayFilter) {
        empty.className = 'mod-empty-msg';
        empty.innerHTML = 'No tests scheduled for this day.<br><span style="color:var(--primary-accent);cursor:pointer;font-size:12px;font-weight:700;" id="tests-clear-day-filter">Click to view all</span>';
        container.appendChild(empty);
        const clearBtn = document.getElementById('tests-clear-day-filter');
        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            state.activeDayFilter = null;
            renderWorkloadStrip();
            renderTestsView(container);
          });
        }
      } else if (state.searchQuery) {
        empty.className = 'mod-empty-msg';
        empty.innerText = `No tests match "${state.searchQuery}"`;
        container.appendChild(empty);
      } else if (state.isScanning) {
        empty.className = 'mod-empty-msg';
        empty.innerText = 'Scanning Canvas & Gradescope...';
        container.appendChild(empty);
      } else {
        empty.className = 'mod-empty-msg';
        empty.innerHTML = 'No exams on the calendar.<br><span class="tests-empty-hint">Syllabus exam dates are picked up automatically — add one below when a prof announces it.</span>';
        container.appendChild(empty);
      }
    }
  }
