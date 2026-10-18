import { STORAGE_KEY_CUSTOM_TESTS } from '../constants.js';

// User-created test/quiz entries for the Tests tab — for exams a prof
// announces in class that never land in Canvas (or that syllabus parsing
// missed). Plain localStorage array, memoized like starred-tasks. Entries:
//   { id, title, courseKey, dateKey ('YYYY-MM-DD' or '' = TBA), createdAt }
// courseKey '' = no course (the entry then ignores the course-filter pill).

let raw;
let parsed = [];

function load() {
    const now = localStorage.getItem(STORAGE_KEY_CUSTOM_TESTS);
    if (now !== raw) {
      try {
        const arr = JSON.parse(now || '[]');
        parsed = Array.isArray(arr)
          ? arr.filter((t) => t && typeof t.title === 'string' && t.title.trim())
          : [];
      } catch { parsed = []; }
      raw = now;
    }
    return parsed;
  }

function save(list) {
    parsed = list;
    raw = JSON.stringify(list);
    try { localStorage.setItem(STORAGE_KEY_CUSTOM_TESTS, raw); } catch {}
  }

export function getCustomTests() {
    return load().slice();
  }

export function addCustomTest({ title, courseKey = '', dateKey = '' }) {
    const clean = String(title || '').trim();
    if (!clean) return null;
    const entry = {
      id: `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: clean.slice(0, 120),
      courseKey: String(courseKey || ''),
      dateKey: /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : '',
      createdAt: Date.now(),
    };
    save(load().concat(entry));
    return entry;
  }

export function deleteCustomTest(id) {
    save(load().filter((t) => t.id !== id));
  }
