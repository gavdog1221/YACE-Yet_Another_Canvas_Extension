import { state } from '../state.js';
import { extractCoreAssignmentToken } from './text.js';

// ---------------------------------------------------------------------------
//  GRADE CORE — the data layer underneath every grade number in YACE.
//
//  Everything here is a pure read of `state` (cached grades + cached course
//  map + the what-if simulations). The math lives in grade-projections.js;
//  the simulator UI lives in components/grade-simulator.js.
//
//  The one rule that matters here: a what-if simulation REPLACES the posted
//  score of the assignment it sits on, it does not get added on top of it.
//  The old simulator summed "posted grade + hypothetical score", so any
//  assignment that had been graded since the simulation was typed counted
//  twice and quietly inflated the course percentage.
// ---------------------------------------------------------------------------

// Letter tiers mirror percentageToGpa() in utils/grades.js: the % floor each
// letter needs. Highest first — the simulator walks them in this order.
export const LETTER_TIERS = [
  { letter: 'A', min: 93 },
  { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 },
  { letter: 'B', min: 83 },
  { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 },
  { letter: 'C', min: 73 },
  { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 },
  { letter: 'D', min: 60 },
];

// Both syllabus *labels* and graded *item titles* are mapped through this
// same ordered list, so a "Final Project 25%" category and a "Final Project"
// assignment land on the same bucket no matter how a syllabus words things.
// Order matters: `final` is deliberately checked first so "Final Exam" and
// "Final Project" group under the same key as the syllabus label.
const CATEGORY_PATTERN = [
  { key: 'final', re: /\bfinal\b/ },
  { key: 'midterm', re: /\bmid[\s-]?terms?\b|\bexam(?:s)?\b|\btest(?:s)?\b/ },
  { key: 'project', re: /\bproject(?:s)?\b/ },
  { key: 'quiz', re: /\bquiz(?:zes|z)?\b/ },
  { key: 'lab', re: /\blab(?:s|oratory)?\b/ },
  { key: 'homework', re: /\b(?:hw|home\s?work|problem\s*set(?:s)?|pset(?:s)?|assignment(?:s)?)\b/ },
  { key: 'writing', re: /\b(?:paper(?:s)?|essay(?:s)?|writing|report(?:s)?)\b/ },
  { key: 'participation', re: /\b(?:participation|attendance|discussion(?:s)?)\b/ },
  { key: 'reading', re: /\breading(?:s)?\b/ },
  { key: 'presentation', re: /\bpresentation(?:s)?\b/ },
];

export function categorizeText(score) {
  const t = String(score || '').toLowerCase();
  if (!t) return 'other';
  for (const p of CATEGORY_PATTERN) {
    if (p.re.test(t)) return p.key;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
//  WHAT-IF SIMULATIONS
// ---------------------------------------------------------------------------

// The simulations typed into the simulator, keyed by task id, for one course.
// state.whatIfScores is flat and covers every course, so it has to be bucketed
// before anything else touches it.
export function getCourseSims(courseKey) {
  const out = {};
  Object.entries(state.whatIfScores || {}).forEach(([taskId, sim]) => {
    if (!sim || sim.courseKey !== courseKey) return;
    out[taskId] = sim;
  });
  return out;
}

// The task a posted grade belongs to. Canvas assignments carry a numeric id
// and both sides carry a normalized title token, so either can match. Returns
// null when the assignment is no longer in the course map (Canvas drops
// already-graded assignments from it) — nothing can be simulated for it then.
export function findTaskForGrade(courseKey, grade) {
  return lookupTask(taskIndex(courseKey), courseKey, grade);
}

// Which assignment a posted grade belongs to, using a prebuilt index.
function lookupTask(index, courseKey, grade) {
  if (!index) return null;
  if (grade.canvasAssignmentId && index.byId[grade.canvasAssignmentId]) return index.byId[grade.canvasAssignmentId];
  const gradeToken = extractCoreAssignmentToken(grade.title, courseKey);
  if (!gradeToken) return null;
  return index.byToken[gradeToken] || null;
}

// The course's assignment index: numeric id -> task, and normalized title
// token -> task.
//
// It is cached because the simulator rebuilds every course's model on every
// keystroke, and the naive lookup normalized every task title for every
// posted grade -- O(grades x tasks) of regex work per keystroke, per course.
// The cache is keyed by a signature of the course map and the grade list, so
// a rescan (which replaces both) rebuilds it.
const taskIndexCache = new Map();

function courseIndexSignature(courseKey) {
  const course = state.cachedCourseMap[courseKey];
  const tasks = (course && course.tasks) || [];
  let sig = `t${tasks.length}:`;
  tasks.forEach(t => { sig += `${t.id}|${t.points}|`; });
  let n = 0;
  (state.cachedGrades || []).forEach(g => {
    if (!g || g.courseKey !== courseKey) return;
    n += 1;
    sig += `${g.canvasAssignmentId || ''}~${g.title}|`;
  });
  return `${sig}g${n}`;
}

function taskIndex(courseKey) {
  const sig = courseIndexSignature(courseKey);
  const hit = taskIndexCache.get(courseKey);
  if (hit && hit.sig === sig) return hit;
  const course = state.cachedCourseMap[courseKey];
  const tasks = (course && course.tasks) || [];
  const byId = {};
  const byToken = {};
  tasks.forEach(t => {
    if (t.canvasAssignmentId) byId[t.canvasAssignmentId] = t;
    const tok = extractCoreAssignmentToken(t.title, courseKey);
    if (tok && !byToken[tok]) byToken[tok] = t;
  });
  const entry = { sig, byId, byToken };
  taskIndexCache.set(courseKey, entry);
  return entry;
}

// The course's graded work with the simulator's scenarios folded in.
//
// A scenario REPLACES the posted score of the assignment it sits on; a
// scenario on work Canvas has not graded yet becomes graded work of its own.
export function getEffectiveGrades(courseKey, opts) {
  const includeSims = !opts || opts.includeSims !== false;
  const sims = includeSims ? getCourseSims(courseKey) : {};
  const course = state.cachedCourseMap[courseKey];
  const tasks = (course && course.tasks) || [];
  const out = [];
  const simulatedTaskIds = new Set();
  // One index for the whole pass: the lookup used to normalize every task
  // title for every posted grade.
  const index = taskIndex(courseKey);

  (state.cachedGrades || []).forEach(g => {
    if (!g || g.courseKey !== courseKey) return;
    if (g.score === null || g.score === undefined) return;
    const task = lookupTask(index, courseKey, g);
    const sim = task ? sims[task.id] : null;
    if (sim && sim.score !== null && sim.score !== undefined && sim.pointsPossible > 0) {
      simulatedTaskIds.add(task.id);
      out.push({
        title: g.title,
        score: sim.score,
        pointsPossible: g.pointsPossible > 0 ? g.pointsPossible : sim.pointsPossible,
        taskId: task.id,
        simulated: true,
        gradedAt: g.gradedAt || null,
      });
      return;
    }
    out.push({
      title: g.title,
      score: g.score,
      pointsPossible: g.pointsPossible,
      taskId: task ? task.id : null,
      simulated: false,
      gradedAt: g.gradedAt || null,
    });
  });

  // Scenarios on work Canvas has not graded yet count as graded work.
  Object.entries(sims).forEach(([taskId, sim]) => {
    if (simulatedTaskIds.has(taskId)) return;
    if (sim.score === null || sim.score === undefined || !(sim.pointsPossible > 0)) return;
    const task = tasks.find(t => t.id === taskId);
    // A scenario whose assignment has left the course map (Canvas drops
    // graded assignments from it) points at nothing. Counting it would add
    // phantom points to the course percentage, so it is ignored here and
    // dropped for good by pruneStaleSimulations().
    if (!task) return;
    out.push({
      title: task.title,
      score: sim.score,
      pointsPossible: sim.pointsPossible,
      taskId,
      simulated: true,
      gradedAt: null,
    });
  });

  return out;
}

// Earned / possible points per grade category (syllabus categories, so
// "Homework 20%" and "Homework 3" land in the same bucket).
export function buildGradedByCategory(courseKey, opts) {
  const map = {};
  getEffectiveGrades(courseKey, opts).forEach(g => {
    if (!(g.pointsPossible > 0)) return;
    const cat = categorizeText(g.title);
    if (!map[cat]) map[cat] = { earned: 0, possible: 0 };
    map[cat].earned += g.score;
    map[cat].possible += g.pointsPossible;
  });
  return map;
}

// Point totals for the "everything counts the same" model (no syllabus
// weights): what has been earned, what it was worth, and how much is left.
export function getCourseGradeTotals(courseKey, opts) {
  const grades = getEffectiveGrades(courseKey, opts);
  let earned = 0;
  let gradedPossible = 0;
  grades.forEach(g => {
    if (!(g.pointsPossible > 0)) return;
    earned += g.score;
    gradedPossible += g.pointsPossible;
  });
  const course = state.cachedCourseMap[courseKey];
  const tasks = ((course && course.tasks) || []).filter(t => t.points && t.points > 0);
  let totalPossible = tasks.reduce((a, t) => a + t.points, 0);
  totalPossible = Math.max(totalPossible, gradedPossible);
  return {
    earned,
    gradedPossible,
    totalPossible,
    remainingPossible: Math.max(0, totalPossible - gradedPossible),
    avgPct: gradedPossible > 0 ? earned / gradedPossible : null,
  };
}

// ---------------------------------------------------------------------------
//  COURSE ITEMS
// ---------------------------------------------------------------------------

// Every point-bearing assignment in the course, with the score it currently
// has: posted, simulated, or none. Grades whose assignment has left the
// course map (Canvas drops graded ones) come along as orphans so they still
// count toward the course percentage even though nothing can be simulated
// for them.
export function getCourseItems(courseKey, opts) {
  const includeSims = !opts || opts.includeSims !== false;
  const course = state.cachedCourseMap[courseKey];
  const tasks = ((course && course.tasks) || []).filter(t => t.points && t.points > 0);
  const grades = getEffectiveGrades(courseKey, { includeSims });
  const byTaskId = {};
  grades.forEach(g => { if (g.taskId) byTaskId[g.taskId] = g; });

  const items = tasks.map(t => {
    const g = byTaskId[t.id];
    return {
      id: t.id,
      task: t,
      title: t.title,
      points: t.points,
      dueDate: t.dueDate || null,
      category: categorizeText(t.title),
      earned: g ? g.score : null,
      simulated: !!(g && g.simulated),
      orphan: false,
    };
  });

  grades.forEach(g => {
    if (g.taskId) return;
    items.push({
      id: null,
      task: null,
      title: g.title,
      points: g.pointsPossible || 0,
      dueDate: null,
      category: categorizeText(g.title),
      earned: g.score,
      simulated: g.simulated,
      orphan: true,
    });
  });

  return items;
}

// Drop scenarios that no longer point at anything: the assignment was graded
// in Canvas (so it left the course map) or the course itself is gone. A
// stale scenario used to keep adding phantom points to the course percentage.
// Returns the number of scenarios that were removed or re-synced so the
// caller knows whether it has to persist.
export function pruneStaleSimulations() {
  const map = state.cachedCourseMap || {};
  if (!Object.keys(map).length) return 0;
  let changed = 0;
  Object.keys(state.whatIfScores || {}).forEach(taskId => {
    const sim = state.whatIfScores[taskId];
    if (!sim) { delete state.whatIfScores[taskId]; changed++; return; }
    const course = map[sim.courseKey];
    if (!course) { delete state.whatIfScores[taskId]; changed++; return; }
    const tasks = course.tasks || [];
    // A course with no tasks is a course that has not been populated yet —
    // do not wipe the user's scenarios on the strength of an empty scan.
    if (!tasks.length) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) { delete state.whatIfScores[taskId]; changed++; return; }
    // The assignment's point value can change between scans (a rubric edit).
    if (task.points && task.points !== sim.pointsPossible) {
      sim.pointsPossible = task.points;
      if (typeof sim.pct === 'number' && sim.pct > 0) sim.score = task.points * sim.pct / 100;
      changed++;
    }
  });
  return changed;
}
