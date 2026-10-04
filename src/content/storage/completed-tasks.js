import { STORAGE_KEY_DONE } from '../constants.js';

// Every render reads the completed map, so JSON.parse on each call was a hot
// path (multiple parses per dashboard rebuild). Memoize the parsed value and
// only re-parse when the raw localStorage string actually changed — which
// also covers writers outside this module (the cross-origin mirror +
// hydration in xstorage.js go through setItem too). Mutating the returned
// object followed by a setItem later is safe: the next read sees the new raw
// string and re-parses.
let completedRaw;
let completedParsed = null;

export function getCompletedTasks() {
    const raw = localStorage.getItem(STORAGE_KEY_DONE);
    if (raw !== completedRaw) {
      try { completedParsed = JSON.parse(raw || '{}'); } catch { completedParsed = {}; }
      completedRaw = raw;
    }
    return completedParsed;
  }

export function setTaskCompleted(taskId, isDone) {
    const data = getCompletedTasks();
    if (isDone) data[taskId] = Date.now();
    else delete data[taskId];
    localStorage.setItem(STORAGE_KEY_DONE, JSON.stringify(data));
  }

// Batch form used by the scanners. Calling setTaskCompleted per task meant one
// full JSON.stringify + localStorage.setItem for EVERY already-submitted task
// in the course map — and each stringify re-serialized a map that kept growing,
// so a heavy term (~500 tasks) turned a single pass into thousands of key
// writes and blocked the main thread on each one. Mutate the memoized map in
// place and flush once.
export function autoCompleteSubmittedTasks(courseMap) {
    const completedMap = getCompletedTasks();
    const now = Date.now();
    let changed = false;
    Object.values(courseMap).forEach(course => {
      (course.tasks || []).forEach(t => {
        if (t.id && t.isSubmitted && !completedMap[t.id]) {
          completedMap[t.id] = now;
          changed = true;
        }
      });
    });
    if (changed) {
      try {
        localStorage.setItem(STORAGE_KEY_DONE, JSON.stringify(completedMap));
      } catch (e) {
        console.warn('[YACE] completed-tasks write failed:', e);
      }
    }
    return changed;
  }
