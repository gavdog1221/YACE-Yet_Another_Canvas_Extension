import { state } from '../state.js';
import { STORAGE_KEY_ANNOUNCEMENTS_CACHE, STORAGE_KEY_ANNOUNCEMENTS_CACHE_TIME, STORAGE_KEY_CACHE, STORAGE_KEY_CACHE_TIME, STORAGE_KEY_COURSE_PERCENTAGES, STORAGE_KEY_GRADES_CACHE, STORAGE_KEY_GRADES_CACHE_TIME, STORAGE_KEY_WHATIF } from '../constants.js';

export function saveWhatIfScores() {
    localStorage.setItem(STORAGE_KEY_WHATIF, JSON.stringify(state.whatIfScores));
  }

export function loadLocalCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_CACHE);
      if (!raw) return null;
      const data = JSON.parse(raw);
      Object.keys(data).forEach(courseKey => {
        (data[courseKey].tasks || []).forEach(t => {
          if (t.dueDate) t.dueDate = new Date(t.dueDate);
          if (t.lateDate) t.lateDate = new Date(t.lateDate);
        });
      });
      return data;
    } catch {
      return null;
    }
  }

export function saveLocalCache(courseMap) {
    try {
      localStorage.setItem(STORAGE_KEY_CACHE, JSON.stringify(courseMap));
      touchLocalCacheTime();
    } catch (e) {
      console.warn('Cache write failed:', e);
    }
  }

// Advance the "a scan just ran" clock on its own. The widget's 30s poll gates
// its background rescan on STORAGE_KEY_CACHE_TIME, so this MUST be stamped
// even when the scan FAILED — otherwise a scan that throws partway through
// never advances the clock and the poll restarts a full scrape every 30
// seconds for the rest of the tab's life. Callers pair this with a `finally`
// (see the end of loadTasks); on success saveLocalCache re-stamps it.
export function touchLocalCacheTime() {
    try {
      localStorage.setItem(STORAGE_KEY_CACHE_TIME, Date.now().toString());
    } catch (e) {
      console.warn('Cache timestamp write failed:', e);
    }
  }

// Switch which grading distribution (multi-distribution syllabi, e.g.
// "Distribution 1 / Distribution 2") is the active gradeWeights set on a
// course. Persists immediately so the pick survives later scans and reloads.
export function applyGradeWeightChoice(courseKey, index) {
    const course = state.cachedCourseMap && state.cachedCourseMap[courseKey];
    const options = course && course.resources && Array.isArray(course.resources.gradeWeightOptions)
      ? course.resources.gradeWeightOptions : null;
    if (!options || options.length < 2) return false;
    const idx = Math.max(0, Math.min(options.length - 1, parseInt(index, 10) || 0));
    course.resources.gradeWeightChoice = idx;
    course.resources.gradeWeights = options[idx].weights || [];
    saveLocalCache(state.cachedCourseMap);
    return true;
  }

export function loadLocalGradesCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_GRADES_CACHE);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return null;
      data.forEach(g => {
        if (g.gradedAt) g.gradedAt = new Date(g.gradedAt);
      });
        return data;
    } catch {
      return null;
    }
  }

export function saveLocalGradesCache(grades) {
    try {
      localStorage.setItem(STORAGE_KEY_GRADES_CACHE, JSON.stringify(grades));
      localStorage.setItem(STORAGE_KEY_GRADES_CACHE_TIME, Date.now().toString());
    } catch (e) {
      console.warn('Grades cache write failed:', e);
    }
  }

export function loadCoursePercentagesCache() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_COURSE_PERCENTAGES) || '{}');
    } catch {
      return {};
    }
  }

export function saveCoursePercentagesCache(data) {
    try {
      localStorage.setItem(STORAGE_KEY_COURSE_PERCENTAGES, JSON.stringify(data));
    } catch (e) {}
  }

export function loadLocalAnnouncementsCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ANNOUNCEMENTS_CACHE);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return null;
      data.forEach(a => {
        if (a.postedAt) a.postedAt = new Date(a.postedAt);
      });
        return data;
    } catch {
      return null;
    }
  }

export function saveLocalAnnouncementsCache(items) {
    try {
      localStorage.setItem(STORAGE_KEY_ANNOUNCEMENTS_CACHE, JSON.stringify(items));
    } catch (e) {
      console.warn('Announcements cache write failed:', e);
    }
  }

// When the announcements cache was last refreshed — drives the standalone
// 15-minute News refresh so it never needs a full rescan to stay current.
export function loadLocalAnnouncementsCacheTime() {
    try {
      return parseInt(localStorage.getItem(STORAGE_KEY_ANNOUNCEMENTS_CACHE_TIME) || '0', 10);
    } catch {
      return 0;
    }
  }

export function saveLocalAnnouncementsCacheTime(ts) {
    try {
      localStorage.setItem(STORAGE_KEY_ANNOUNCEMENTS_CACHE_TIME, String(ts));
    } catch (e) {}
  }
