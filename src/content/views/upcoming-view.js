import { state } from '../state.js';
import { deleteAssignmentFromModal, ensureAssignmentModal, openAssignmentModal } from '../components/assignment-modal.js';
import { openPdfModal } from '../components/pdf-modal.js';
import { openSubmissionModal } from '../components/submission-modal.js';
import { openCanvasViewer } from '../components/canvas-viewer.js';
import { getCompletedTasks, setTaskCompleted } from '../storage/completed-tasks.js';
import { applyCustomDueDates, effectiveDueDate, setCustomDueDate } from '../storage/custom-due-dates.js';
import { getHiddenCourses, hideCourse } from '../storage/hidden-courses.js';
import { getStarredTasks, isTaskStarred, toggleStarredTask, withStarredFirst } from '../storage/starred-tasks.js';
import { getCourseColors, parseColorToRgba } from '../utils/colors.js';
import { getWeekBounds, localDateKey } from '../utils/dates.js';
import { escapeHTML } from '../utils/text.js';
import { renderAnnouncementsView } from '../views/announcements-view.js';
import { renderDashboardView } from '../views/dashboard-view.js';
import { renderGeneralView } from '../views/general-view.js';
import { renderGradesView, updateGradeChangeBadge } from '../views/grades-view.js';
import { renderScheduleView } from '../views/schedule-view.js';

export function renderWorkloadStrip() {
    const container = document.getElementById('workload-strip-container');
    if (!container) return;
    container.innerHTML = '';

    const completedMap = getCompletedTasks();
    const hiddenCourses = getHiddenCourses();
    const now = new Date();
    const days = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const isoKey = localDateKey(d);

      let label = d.toLocaleDateString([], { weekday: 'short' });
      if (i === 0) label = 'Today';
      else if (i === 1) label = 'Tmrw';

      days.push({
        dateKey: isoKey,
        label: label,
        isUrgent: i <= 1,
        count: 0
      });
    }

    Object.entries(state.cachedCourseMap).forEach(([courseKey, course]) => {
      if (hiddenCourses.includes(courseKey)) return;
      (course.tasks || []).forEach(t => {
        const ed = effectiveDueDate(t);
        if (!ed || completedMap[t.id]) return;
        const taskKey = localDateKey(ed);
        const dayMatch = days.find(d => d.dateKey === taskKey);
        if (dayMatch) dayMatch.count++;
      });
    });

    days.forEach(day => {
      const dayEl = document.createElement('div');
      dayEl.className = `workload-day ${day.count > 0 ? 'has-tasks' : ''} ${day.isUrgent && day.count > 0 ? 'has-urgent' : ''} ${state.activeDayFilter === day.dateKey ? 'active' : ''}`;
      dayEl.innerHTML = `
      <span class="day-name">${day.label}</span>
      <span class="day-count">${day.count}</span>
      `;

      dayEl.addEventListener('click', () => {
        if (state.activeDayFilter === day.dateKey) {
          state.activeDayFilter = null;
        } else {
          state.activeDayFilter = day.dateKey;
          state.currentTab = 'upcoming';
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === 'upcoming'));
        }
        renderWorkloadStrip();
        renderCurrentView();
      });

      container.appendChild(dayEl);
    });
  }

export function updateProgressBar() {
    const completedMap = getCompletedTasks();
    const hiddenCourses = getHiddenCourses();
    const countedIds = new Set();
    const { endOfWeek } = getWeekBounds();

    let total = 0;
    let completed = 0;

    // NOTE: This intentionally counts anything due by the end of this week,
    // including tasks that are already overdue from prior weeks (as long as
    // they aren't done). A previous version only counted tasks whose due
    // date fell strictly between Monday and Sunday of the current week,
    // which meant checking off an overdue task (or a task completed ahead
    // of a future-week due date) never changed `completed`/`total` and the
    // bar appeared "stuck". Rolling overdue work into the current week's
    // bucket keeps the bar responsive to the actions people actually take.
    Object.entries(state.cachedCourseMap).forEach(([courseKey, c]) => {
      if (hiddenCourses.includes(courseKey)) return;
      (c.tasks || []).forEach(t => {
        if (!t.id || countedIds.has(t.id)) return;

        const ed = effectiveDueDate(t);
        const isDone = !!completedMap[t.id];
        if (!ed || ed > endOfWeek) {
          return;
        }
        // Skip stale overdue clutter that was never marked done and is long
        // past due (more than 4 weeks) so ancient, abandoned items don't
        // permanently drag the bar down; still count anything done recently
        // or due within this week.
        if (!isDone && (endOfWeek.getTime() - ed.getTime()) > 28 * 24 * 60 * 60 * 1000) {
          return;
        }

        countedIds.add(t.id);

        total++;
        if (isDone) {
          completed++;
        }
      });
    });

    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const fillEl = document.getElementById('progress-bar-fill');
    const labelEl = document.getElementById('progress-label');
    const countEl = document.getElementById('progress-count');
    const container = document.querySelector('.progress-container');

    if (!fillEl || !labelEl || !countEl) return;

    fillEl.style.setProperty('width', `${percent}%`, 'important');
    fillEl.classList.remove('tier-low', 'tier-mid', 'tier-high', 'tier-complete');

    if (total === 0) {
      labelEl.innerText = 'No tasks due this week';
      if (container) container.classList.remove('is-all-done');
    } else if (percent === 100) {
      fillEl.classList.add('tier-complete');
      labelEl.innerText = '✨ 100% Week Done!';
      if (container) container.classList.add('is-all-done');
    } else if (percent >= 70) {
      fillEl.classList.add('tier-high');
      labelEl.innerText = `${percent}% this week`;
      if (container) container.classList.remove('is-all-done');
    } else if (percent >= 30) {
      fillEl.classList.add('tier-mid');
      labelEl.innerText = `${percent}% this week`;
      if (container) container.classList.remove('is-all-done');
    } else {
      fillEl.classList.add('tier-low');
      labelEl.innerText = `${percent}% this week`;
      if (container) container.classList.remove('is-all-done');
    }

    countEl.innerText = `${completed}/${total} this week`;
  }

// One entry point for every "filter by class" interaction (the filter
// dropdown, grade cards, and the course chips on task cards / announcements /
// info cards). A course filter is GLOBAL — forceDashboardRebuild makes every
// scrape-derived panel (News / Recent Grades / Grades / Info) rebuild with the
// filter applied. Before, a filter change only re-rendered the Assignments
// list while the other panels kept showing every course, which made the
// filter look broken.
export function applyCourseFilter(courseKey) {
    // 'ALL' always clears the filter; any other key toggles that course on/off.
    state.activeCourseFilter = (courseKey === 'ALL' || state.activeCourseFilter === courseKey) ? 'ALL' : courseKey;
    state.forceDashboardRebuild = true;
    renderFilterPills();
    renderCurrentView();
  }

export function renderFilterPills() {
    const menu = document.getElementById('course-filter-menu');
    const label = document.getElementById('course-filter-label');
    const trigger = document.getElementById('course-filter-btn');
    if (!menu || !label) return;

    menu.innerHTML = '';
    const hiddenCourses = getHiddenCourses();
    const allKeys = Object.keys(state.cachedCourseMap);
    const visibleKeys = allKeys.filter(k => !hiddenCourses.includes(k));

    label.textContent = state.activeCourseFilter === 'ALL' ? 'All' : state.activeCourseFilter;

    // "All" item
    const allItem = document.createElement('div');
    allItem.className = `course-filter-item ${state.activeCourseFilter === 'ALL' ? 'active' : ''}`;
    allItem.innerHTML = `<span>All Courses</span>`;
    allItem.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      applyCourseFilter('ALL');
    });
    menu.appendChild(allItem);

    visibleKeys.forEach(k => {
      const item = document.createElement('div');
      const palette = getCourseColors(k);
      item.className = `course-filter-item ${state.activeCourseFilter === k ? 'active' : ''}`;
      item.innerHTML = `
      <span class="cf-item-left"><span class="cf-dot" style="background:${palette.accent}"></span>${escapeHTML(k)}</span>
      <span class="cf-remove" title="Hide class">×</span>
      `;

      item.querySelector('.cf-item-left').addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        applyCourseFilter(k);
      });

      item.querySelector('.cf-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        hideCourse(k);
      });

      menu.appendChild(item);
    });

    if (trigger && !trigger.hasAttribute('data-bound')) {
      trigger.setAttribute('data-bound', 'true');
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('open');
      });
      document.addEventListener('click', () => menu.classList.remove('open'));
    }
  }

export function createTaskCard(task, now, completedMap) {
    const isDone = !!completedMap[task.id];
    const isStarred = isTaskStarred(task.id);
    const card = document.createElement('div');

    const hasRealDueDate = !!task.dueDate;
    // effectiveDueDate rolls a task onto its LATE deadline once the regular
    // one has passed, so the card shows (and counts down to) the date that is
    // actually still actionable instead of an already-passed regular one.
    const dueDate = effectiveDueDate(task, now) || null;
    const isCustomDate = !hasRealDueDate && !!task.customDueDate;
    // True while the displayed date IS the rolled-over late deadline, so the
    // label can say so instead of looking like the original due date.
    const lateDateObj = task.lateDate ? new Date(task.lateDate) : null;
    const isLateRollOver = !!(hasRealDueDate && dueDate && lateDateObj
      && !isNaN(lateDateObj.getTime())
      && lateDateObj.getTime() > task.dueDate.getTime()
      && dueDate.getTime() === lateDateObj.getTime()
      && now.getTime() > task.dueDate.getTime());

    let urgencyClass = '';
    let dueLabel = '';
    let statusBadgeHtml = '';
    let isCritical = false;

    const editBtnHtml = !hasRealDueDate
    ? `<button type="button" class="edit-date-btn" title="${isCustomDate ? 'Edit custom due date' : 'Set due date'}">✏️</button>`
    : '';

    if (dueDate) {
      const diffMs = dueDate.getTime() - now.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

      const dateStr = dueDate.toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });

      const isTomorrow = (() => {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return dueDate.toDateString() === d.toDateString();
      })();

      const isToday = dueDate.toDateString() === now.toDateString();

      if (diffMs < 0) {
        urgencyClass = 'due-overdue';
        const hoursAgo = Math.abs(diffHours);
        const lateStr = hoursAgo < 24 ? `${hoursAgo}h late` : `${Math.floor(hoursAgo / 24)}d late`;
        statusBadgeHtml = `<span class="badge-tag overdue">${lateStr}</span>`;
        dueLabel = `Due ${dateStr}`;
      } else if (diffMs <= 24 * 60 * 60 * 1000) {
        urgencyClass = 'due-today';
        if (diffHours < 2) isCritical = true;

        let countdownStr = '';
        if (diffHours >= 1) {
          countdownStr = `${diffHours}h left`;
        } else {
          countdownStr = `${diffMins}m left`;
        }
        statusBadgeHtml = `<span class="badge-tag countdown-urgent"><span class="pulsing-dot"></span>${countdownStr}</span>`;
        dueLabel = isToday ? `Today (${dateStr})` : `Tomorrow (${dateStr})`;
      } else if (isTomorrow) {
        urgencyClass = 'due-tomorrow';
        statusBadgeHtml = `<span class="badge-tag tomorrow">Tomorrow</span>`;
        dueLabel = `Due ${dateStr}`;
      } else {
        dueLabel = `Due ${dateStr}`;
      }

      // The displayed date IS the rolled-over late deadline now — label it
      // so it isn't mistaken for the regular due date.
      if (isLateRollOver && urgencyClass !== 'due-overdue') {
        dueLabel = `${dueLabel} · late`;
      }

      if (isCustomDate) {
        statusBadgeHtml += ` <span class="date-badge-wrap">${editBtnHtml}<span class="badge-tag custom-date-chip">✏️ Custom</span></span>`;
      }
    } else {
      urgencyClass = 'undated';
      dueLabel = '';
      statusBadgeHtml = `<span class="date-badge-wrap">${editBtnHtml}<span class="badge-tag undated-chip">⚠ NO DUE DATE</span></span>`;
    }

    // Multi-date deadline: the regular due date plus a LATER one (a Canvas
    // "Assign to: Section"-style override, or a Gradescope submission-window
    // close, e.g. Sep 22 → Sep 24). Surface the range while the regular date
    // is still the displayed one; once effectiveDueDate has rolled onto the
    // late date the keys match and the suffix collapses (the "· late" marker
    // above already says it). Same-day windows collapse too.
    if (lateDateObj && dueDate && !isNaN(lateDateObj.getTime()) && localDateKey(lateDateObj) !== localDateKey(dueDate)) {
      const lateStr = lateDateObj.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      dueLabel = dueLabel ? `${dueLabel} · Late ${lateStr}` : `Late ${lateStr}`;
    }

    if (task.isSubmitted) {
      statusBadgeHtml += ` <span class="badge-tag submitted-badge" title="Draft or file already submitted, awaiting evaluation">✓ Submitted</span>`;
    }

    // Top Right Points Chip
    let pointsHtml = '';
    if (task.points !== null) {
      pointsHtml = `<span class="badge-tag points-chip top-points-tag">${task.points} pts</span>`;
    }

    // Bottom Right Actions (Gradescope tag & direct upload, Document Actions)
    let rightBottomMeta = '';
    if (task.isGradescope) {
      rightBottomMeta += `<span class="badge-tag gs-source">GS</span>`;
      if (task.gradescopeUploadUrl && !isDone) {
        rightBottomMeta += `<a href="${escapeHTML(task.gradescopeUploadUrl)}" target="_blank" class="gs-upload-pill" title="Upload directly to Gradescope">Upload ⇪</a>`;
      }
    }

    // Canvas tasks get an in-place submission popup (text / file / URL) next
    // to the document buttons — custom tasks and pure Gradescope items have
    // no Canvas assignment id to post to, but a MERGED Canvas+Gradescope task
    // does, so it keeps the Canvas submit button alongside the GS upload.
    if (!task.isCustom && task.canvasAssignmentId && task.canvasCourseId) {
      rightBottomMeta += `<button type="button" class="submit-pill" title="${task.isSubmitted ? 'Resubmit to Canvas' : 'Submit to Canvas'}">↑ Submit</button>`;
    }

    if (task.downloadUrl) {
      rightBottomMeta += `
      <div class="doc-actions-wrap">
      <button type="button" class="doc-view-pill" data-doc-url="${escapeHTML(task.downloadUrl)}" data-doc-title="${escapeHTML(task.title)}" data-course-id="${task.canvasCourseId || ''}" data-file-id="${task.contentId || ''}" title="Preview Document">👁</button>
      <a href="${task.downloadUrl}" class="download-pill" download target="_blank" title="Download Document">PDF ⤓</a>
      </div>
      `;
    }

    if (task.isCustom) {
      rightBottomMeta += `
      <div class="radial-custom-wrap" title="Custom Task Actions">
      <button type="button" class="radial-custom-trigger">
      ${task.isRecurring ? '↻' : '✦'}
      </button>
      <div class="radial-custom-menu">
      <button type="button" class="custom-pie-slice custom-edit-slice custom-edit-btn" data-template-id="${escapeHTML(task.templateId)}" title="Edit assignment">
      <span>✏️</span>
      </button>
      <button type="button" class="custom-pie-slice custom-del-slice custom-delete-btn" data-template-id="${escapeHTML(task.templateId)}" title="Delete assignment">
      <span>🗑</span>
      </button>
      </div>
      </div>
      `;
    }
    // Assign Canvas Native Color
    let coursePalette = getCourseColors(task.courseKey, task.canvasCourseId);
    if (task.isCustom && task.customColor) {
      coursePalette = {
        accent: task.customColor,
        glow: parseColorToRgba(task.customColor, 0.45) || coursePalette.glow,
                                    soft: parseColorToRgba(task.customColor, 0.14) || coursePalette.soft
      };
    }
    card.style.setProperty('--task-course-accent', coursePalette.accent);
    card.style.setProperty('--task-course-glow', coursePalette.glow);
    card.style.setProperty('--task-course-soft', coursePalette.soft);

    card.className = `mod-task-card ${urgencyClass} ${isCritical ? 'critical-pulse' : ''} ${task.isGradescope ? 'gradescope-item' : ''} ${isDone ? 'is-completed' : ''} ${isStarred ? 'is-starred' : ''}`;

    card.innerHTML = `
    <input type="checkbox" class="task-checkbox" ${isDone ? 'checked' : ''} title="Mark as done (Press x)">
    <div class="task-body">
    <div class="task-title-row">
    <button type="button" class="star-btn ${isStarred ? 'is-starred' : ''}" title="${isStarred ? 'Unpin from top' : 'Pin to top'}">★</button>
    <a class="mod-task-title ${task.isCustom ? 'custom-task-title' : ''}" href="${task.isCustom ? 'javascript:void(0)' : task.url}" ${task.isCustom ? '' : 'target="_blank"'} ${!task.isCustom && task.canvasCourseId && task.canvasAssignmentId ? 'data-canvas-open="assignment"' : ''} title="${task.notes ? escapeHTML(task.notes) : ''}">${escapeHTML(task.title)}</a>
    ${pointsHtml}
    </div>
    <div class="task-meta-row">
    <div class="task-meta-left">
    <span class="course-tag-chip">${escapeHTML(task.courseKey)}</span>
    ${dueLabel ? `<span class="due-indicator">${dueLabel}</span>` : ''}
    ${statusBadgeHtml}
    </div>
    <div class="task-meta-right">
    ${rightBottomMeta}
    </div>
    </div>
    ${!hasRealDueDate ? `
      <div class="date-edit-row">
      <input type="date" class="date-edit-input" value="${isCustomDate ? localDateKey(dueDate) : ''}">
      <button type="button" class="date-edit-save">Save</button>
      ${isCustomDate ? '<button type="button" class="date-edit-clear">Clear</button>' : ''}
      </div>
      ` : ''}
      </div>
      `;

      // Clicking the class chip applies the course filter to the whole
      // dashboard (clicking the already-filtered class clears it).
      const courseChip = card.querySelector('.course-tag-chip');
      if (courseChip) {
        courseChip.title = state.activeCourseFilter === task.courseKey
        ? 'Showing only this class — click to clear'
        : 'Show only this class';
        courseChip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyCourseFilter(task.courseKey);
        });
      }

      // Hook PDF Preview Modal Trigger
      const viewBtn = card.querySelector('.doc-view-pill');
      if (viewBtn) {
        viewBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPdfModal(
            viewBtn.getAttribute('data-doc-url'),
                       viewBtn.getAttribute('data-doc-title'),
                       viewBtn.getAttribute('data-course-id'),
                       viewBtn.getAttribute('data-file-id')
          );
        });
      }

      // Hook Custom Assignment edit/delete (and title click for custom tasks,
      // since they have no external URL to open)
      if (task.isCustom) {
        const titleLink = card.querySelector('.custom-task-title');
        if (titleLink) {
          titleLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openAssignmentModal(task.templateId);
          });
        }

        const customEditBtn = card.querySelector('.custom-edit-btn');
        if (customEditBtn) {
          customEditBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openAssignmentModal(task.templateId);
          });
        }

        const customDeleteBtn = card.querySelector('.custom-delete-btn');
        if (customDeleteBtn) {
          customDeleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.editingAssignmentId = task.templateId;
            const modal = ensureAssignmentModal();
            deleteAssignmentFromModal(modal);
          });
        }
      }

      // Canvas assignment titles open the in-app YACE viewer instead of a
      // new tab (the href stays so middle-click/ctrl+click still works).
      const cvTitle = card.querySelector('.mod-task-title[data-canvas-open]');
      if (cvTitle && task.canvasCourseId && task.canvasAssignmentId) {
        cvTitle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCanvasViewer({
            kind: 'assignment',
            courseId: task.canvasCourseId,
            assignmentId: task.canvasAssignmentId,
            courseKey: task.courseKey,
            courseName: task.courseName,
            title: task.title,
            url: task.url
          });
        });
      }

      // Hook Canvas submission popup
      const submitBtn = card.querySelector('.submit-pill');
      if (submitBtn) {
        submitBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openSubmissionModal(task);
        });
      }

      // Hook Star / Pin-to-top toggle
      const starBtn = card.querySelector('.star-btn');
      if (starBtn) {
        starBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleStarredTask(task.id);
          renderCurrentView();
        });
      }

      const checkbox = card.querySelector('.task-checkbox');
      checkbox.addEventListener('change', (e) => {
        const willBeDone = e.target.checked;

        setTaskCompleted(task.id, willBeDone);
        updateProgressBar();

        if (willBeDone) {
          if (state.currentTab !== 'completed') {
            card.classList.add('dismissing');
            setTimeout(() => {
              renderWorkloadStrip();
              renderCurrentView();
            }, 240);
            return;
          }
        }

        renderWorkloadStrip();
        renderCurrentView();
      });

      if (!hasRealDueDate) {
        const editBtn = card.querySelector('.edit-date-btn');
        const editRow = card.querySelector('.date-edit-row');
        const dateInput = card.querySelector('.date-edit-input');
        const saveBtn = card.querySelector('.date-edit-save');
        const clearBtn = card.querySelector('.date-edit-clear');

        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const willOpen = !editRow.classList.contains('is-visible');
          editRow.classList.toggle('is-visible', willOpen);
          if (willOpen) dateInput.focus();
        });

          saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!dateInput.value) {
              dateInput.focus();
              return;
            }
            const picked = new Date(`${dateInput.value}T23:59:00`);
            if (isNaN(picked.getTime())) return;

            setCustomDueDate(task.id, picked.toISOString());
            applyCustomDueDates();
            updateProgressBar();
            renderWorkloadStrip();
            renderCurrentView();
          });

          if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              setCustomDueDate(task.id, null);
              applyCustomDueDates();
              updateProgressBar();
              renderWorkloadStrip();
              renderCurrentView();
            });
          }
      }

      return card;
  }

export function renderCurrentView() {
    const listContainer = document.getElementById('module-tasks-list');

    // Fullscreen relocates the weekday ribbon + search bar into the top of
    // the center Assignments panel, i.e. INSIDE #module-tasks-list, so the
    // wipe below would detach them and a later getElementById would come up
    // empty -- the old "click Due/Overdue/Done (or any re-render) and the
    // pills/search disappear" bug. Capture live node refs BEFORE the wipe
    // and hand them to renderDashboardView so the SAME elements are
    // re-mounted on every rebuild instead of being lost.
    const fsStrip = state.isFullscreen ? document.getElementById('workload-strip-container') : null;
    const fsSearchRow = state.isFullscreen ? document.querySelector('#module-tasks-widget .search-bar-row') : null;
    const fsProgress = state.isFullscreen ? document.querySelector('#module-tasks-widget .progress-container') : null;

    // Fullscreen owns the grid lifecycle: renderDashboardView captures the
    // mounted scrape panels BEFORE wiping, so rebuilding one list must never
    // force the Grades/News/Info panels to re-render (that used to reset
    // their scroll + what-if state on every button click). Only wipe here in
    // the sidebar path where this function IS the renderer.
    if (!state.isFullscreen) {
      listContainer.innerHTML = '';
    }
    state.selectedTaskIndex = -1;
    updateGradeChangeBadge();

    const completedMap = getCompletedTasks();
    const hiddenCourses = getHiddenCourses();
    const starredMap = getStarredTasks();
    const now = new Date();

    const viewSignature = `${state.currentTab}|${state.activeCourseFilter}|${state.activeDayFilter}|${state.assignmentRangeFilter}|${state.searchQuery}`;
    if (viewSignature !== state.lastViewSignature) {
      state.showAllCompleted = false;
      state.showAllOverdue = false;
      state.lastViewSignature = viewSignature;
    }

    const taskActionBar = document.getElementById('tasks-action-bar');
    if (taskActionBar) {
      taskActionBar.style.display = (state.currentTab === 'upcoming' || state.currentTab === 'overdue' || state.currentTab === 'completed') ? 'flex' : 'none';
    }
    let totalOverdueCount = 0;
    let renderedCount = 0;
    let showBigEmptyState = true;

    Object.entries(state.cachedCourseMap).forEach(([courseKey, c]) => {
      if (hiddenCourses.includes(courseKey)) return;
      (c.tasks || []).forEach(t => {
        const ed = effectiveDueDate(t);
        if (ed && ed < now && !completedMap[t.id]) totalOverdueCount++;
      });
    });

    const overdueBadge = document.getElementById('overdue-total-badge');
    const hudOverdueBadge = document.getElementById('hud-overdue-badge');
    if (overdueBadge) {
      overdueBadge.innerText = totalOverdueCount > 0 ? `(${totalOverdueCount})` : '';
    }
    if (hudOverdueBadge) {
      hudOverdueBadge.style.display = totalOverdueCount > 0 ? 'inline-flex' : 'none';
      hudOverdueBadge.innerText = totalOverdueCount;
    }

    // Full screen shows every tab at once (see dashboard-view.js) instead of
    // the single active tab. Pass the pre-wipe ribbon/search node refs so
    // those controls survive the rebuild.
    if (state.isFullscreen) {
      renderDashboardView(listContainer, fsStrip, fsSearchRow, fsProgress);
      return;
    }

    if (state.currentTab === 'grades') {
      renderGradesView(listContainer, hiddenCourses);
      return;
    }

    if (state.currentTab === 'announcements') {
      renderAnnouncementsView(listContainer, hiddenCourses);
      return;
    }

    if (state.currentTab === 'general') {
      renderGeneralView(listContainer, hiddenCourses);
      return;
    }

    if (state.currentTab === 'schedule') {
      renderScheduleView(listContainer);
      return;
    }

    renderTaskList(listContainer);
  }

// Renders the vertical task list into any container — used by the sidebar
// (the tail of renderCurrentView) and by the fullscreen center Assignments
// panel (dashboard-view.js). The filter/sort/show-more logic is identical for
// both; only the DOM target differs. The active tab is normalized so an
// unrelated tab (e.g. a corner view) falls back to Due semantics.
export function renderTaskList(container) {
    const listContainer = container;
    // Clear before rebuilding: the 30s poll calls this on the fullscreen
    // Assignments panel and tab switches rebuild #module-tasks-list, so
    // appending without clearing stacked duplicate cards on every tick.
    listContainer.innerHTML = '';
    const completedMap = getCompletedTasks();
    const hiddenCourses = getHiddenCourses();
    const starredMap = getStarredTasks();
    const now = new Date();
    const tab = (state.currentTab === 'completed' || state.currentTab === 'overdue') ? state.currentTab : 'upcoming';

    let allFilteredTasks = [];
    let renderedCount = 0;
    let showBigEmptyState = true;

    Object.keys(state.cachedCourseMap).forEach(courseKey => {
      if (hiddenCourses.includes(courseKey)) return;
      if (state.activeCourseFilter !== 'ALL' && state.activeCourseFilter !== courseKey) return;
      const course = state.cachedCourseMap[courseKey];
      if (!course.tasks) return;

      const tasks = course.tasks.filter(t => {
        const isDone = !!completedMap[t.id];
        const ed = effectiveDueDate(t);
        const isOverdue = ed && ed < now;

        if (state.activeDayFilter) {
          if (!ed) return false;
          if (localDateKey(ed) !== state.activeDayFilter) return false;
        }

        if (tab === 'upcoming' && ed && state.assignmentRangeFilter !== 'all') {
          const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
          if (state.assignmentRangeFilter === 'today') {
            if (ed > endOfToday) return false;
          } else if (state.assignmentRangeFilter === 'week') {
            const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - now.getDay()), 23, 59, 59, 999);
            if (ed > endOfWeek) return false;
          } else if (state.assignmentRangeFilter === '2weeks') {
            const endOf2Weeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            if (ed > endOf2Weeks) return false;
          } else if (state.assignmentRangeFilter === 'month') {
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            if (ed > endOfMonth) return false;
          }
        }

        if (state.searchQuery && !t.title.toLowerCase().includes(state.searchQuery)) return false;
        if (tab === 'completed') return isDone;
        if (isDone) return false;
        if (tab === 'overdue') return isOverdue;
        if (tab === 'upcoming') return !isOverdue;
        return true;      });

        allFilteredTasks.push(...tasks);
    });

    if (tab === 'completed' || tab === 'overdue') {
      // Always render Completed/Overdue as a single sorted list scoped to
      // the current week by default — showing every task ever doesn't fix
      // the bloat problem since a single course can rack up dozens of
      // finished or missed items on its own.
      if (tab === 'completed') {
        // Most recently completed first.
        allFilteredTasks.sort(withStarredFirst((a, b) => (completedMap[b.id] || 0) - (completedMap[a.id] || 0), starredMap));
      } else {
        // Most recently overdue (closest to now) first, so the freshest,
        // most-likely-actionable misses surface above semester-old ones.
        allFilteredTasks.sort(withStarredFirst((a, b) => {
          const edA = effectiveDueDate(a);
          const edB = effectiveDueDate(b);
          if (edA && edB) return edB - edA;
          if (edA) return -1;
          if (edB) return 1;
          return 0;
        }, starredMap));
      }

      const { startOfWeek, endOfWeek } = getWeekBounds();
      const thisWeekTasks = allFilteredTasks.filter(t => {
        const ed = effectiveDueDate(t);
        return ed && ed >= startOfWeek && ed <= endOfWeek;
      });

      const showAll = tab === 'completed' ? state.showAllCompleted : state.showAllOverdue;
      const visibleTasks = showAll ? allFilteredTasks : thisWeekTasks;
      renderedCount = visibleTasks.length;

      if (allFilteredTasks.length > 0) {
        showBigEmptyState = false;

        if (visibleTasks.length === 0) {
          const scopedEmpty = document.createElement('div');
          scopedEmpty.className = 'mod-empty-msg';
          scopedEmpty.innerText = tab === 'completed'
          ? '✨ Nothing completed this week yet.'
          : '🎉 No assignments overdue this week.';
          listContainer.appendChild(scopedEmpty);
        } else {
          visibleTasks.forEach(task => {
            listContainer.appendChild(createTaskCard(task, now, completedMap));
          });
        }

        const hiddenCount = allFilteredTasks.length - thisWeekTasks.length;
        if (!showAll && hiddenCount > 0) {
          const showMoreBtn = document.createElement('button');
          showMoreBtn.type = 'button';
          showMoreBtn.className = 'show-more-tasks-btn';
          showMoreBtn.innerText = `Show all (${hiddenCount} more from earlier)`;
          showMoreBtn.addEventListener('click', () => {
            if (tab === 'completed') state.showAllCompleted = true;
            else state.showAllOverdue = true;
            renderCurrentView();
          });
          listContainer.appendChild(showMoreBtn);
        } else if (showAll && hiddenCount > 0) {
          const collapseBtn = document.createElement('button');
          collapseBtn.type = 'button';
          collapseBtn.className = 'show-more-tasks-btn';
          collapseBtn.innerText = 'Show only this week';
          collapseBtn.addEventListener('click', () => {
            if (tab === 'completed') state.showAllCompleted = false;
            else state.showAllOverdue = false;
            renderCurrentView();
          });
          listContainer.appendChild(collapseBtn);
        }
      }
    } else {
      allFilteredTasks.sort(withStarredFirst((a, b) => {
        const edA = effectiveDueDate(a);
        const edB = effectiveDueDate(b);
        if (edA && edB) return edA - edB;
        if (edA) return -1;
        if (edB) return 1;
        return 0;
      }, starredMap));

      renderedCount = allFilteredTasks.length;
      allFilteredTasks.forEach(task => {
        listContainer.appendChild(createTaskCard(task, now, completedMap));
      });
    }

    if (renderedCount === 0 && showBigEmptyState) {
      if (state.activeDayFilter) {
        listContainer.innerHTML = `<div class="mod-empty-msg">No tasks scheduled for this day.<br><span style="color:var(--primary-accent);cursor:pointer;font-size:12px;font-weight:700;" id="clear-day-filter">Click to view all</span></div>`;
        const clearBtn = document.getElementById('clear-day-filter');
        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            state.activeDayFilter = null;
            renderWorkloadStrip();
            renderCurrentView();
          });
        }
      } else if (state.searchQuery) {
        listContainer.innerHTML = `<div class="mod-empty-msg">No assignments match "${escapeHTML(state.searchQuery)}"</div>`;
      } else if (tab === 'overdue') {
        listContainer.innerHTML = '<div class="mod-empty-msg">✨ No overdue assignments! You are all caught up.</div>';
      } else if (tab === 'completed') {
        listContainer.innerHTML = '<div class="mod-empty-msg">No completed assignments yet.</div>';
      } else if (state.isScanning) {
        listContainer.innerHTML = '<div class="mod-empty-msg">Scanning Canvas & Gradescope...</div>';
      } else {
        listContainer.innerHTML = '<div class="mod-empty-msg">🎉 All clear! No upcoming tasks due.</div>';
      }
    }
  }
