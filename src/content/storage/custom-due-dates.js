import { state } from '../state.js';
import { STORAGE_KEY_CUSTOM_DUE } from '../constants.js';

export function getCustomDueDates() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_CUSTOM_DUE) || '{}');
    } catch { return {}; }
  }

export function setCustomDueDate(taskId, isoStringOrNull) {
    const data = getCustomDueDates();
    if (isoStringOrNull) data[taskId] = isoStringOrNull;
    else delete data[taskId];
    localStorage.setItem(STORAGE_KEY_CUSTOM_DUE, JSON.stringify(data));
  }

export function applyCustomDueDates() {
    const customDates = getCustomDueDates();
    Object.values(state.cachedCourseMap).forEach(course => {
      (course.tasks || []).forEach(t => {
        if (!t.dueDate && customDates[t.id]) {
          const d = new Date(customDates[t.id]);
          t.customDueDate = isNaN(d.getTime()) ? null : d;
        } else {
          t.customDueDate = null;
        }
      });
    });
  }

// The operative deadline for a task. Most tasks just have one due date, but
// some carry a LATER "late" deadline as well (a Canvas "Assign to: Section"
// override, or a Gradescope submission-window close). Once the regular date
// has passed and the late one is still ahead, the late date becomes the
// operative deadline — that is what keeps the task sitting in the Due tab
// (instead of flipping to Overdue) with the late date shown, until the late
// window itself closes.
export function effectiveDueDate(t, now = new Date()) {
    const base = t.dueDate || t.customDueDate || null;
    if (!base || !t.lateDate) return base;
    const late = (t.lateDate instanceof Date) ? t.lateDate : new Date(t.lateDate);
    if (isNaN(late.getTime()) || late.getTime() <= base.getTime()) return base;
    return now.getTime() > base.getTime() ? late : base;
  }
