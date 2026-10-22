import { state } from '../state.js';
import {
  LETTER_TIERS,
  categorizeText,
  getCourseItems,
} from './grade-core.js';

// Letter tiers live in grade-core.js now (they are shared with the
// simulator); re-exported here so existing importers keep working.
export { LETTER_TIERS };

// ---------------------------------------------------------------------------
//  THE COURSE MODEL
//
//  Every course grade YACE shows is a point on one line:
//
//      grade(q) = floorPct + q × gainPct
//
//  where q is the fraction (0-100%) scored on the work that is still open.
//  `floorPct` is the grade with every open item counted as zero, and
//  `gainPct` is how much the grade moves per 1% scored on that open work.
//
//  Both models are linear in q, which is why "what do I need" is a single
//  subtraction instead of a pile of case-by-case math:
//
//    · Equal points  — the syllabus has no breakdown, so every point counts
//      the same. floorPct = earned / totalPossible, gainPct = openPoints /
//      totalPossible.
//
//    · Syllabus weighted — each category (Homework 20%, Final 30%, …) counts
//      for its stated share. A category that is only half graded contributes
//      w × (earned / (graded + open)) so the still-open half is honestly
//      counted as worth zero until it is scored, and contributes
//      w × (open / (graded + open)) of headroom.
//
//  "Grade so far" (what Canvas shows, and what the GPA is built from) stays
//  a separate number: it only counts work that HAS a score, renormalized
//  over the syllabus categories that do.
// ---------------------------------------------------------------------------

const round1 = (n) => Math.round(n * 10) / 10;

// Builds the full model for one course. `opts.includeSims === false` gives
// the same course as it stands without the what-if scenarios, which is what
// the simulator compares against.
export function buildCourseModel(courseKey, opts) {
  const includeSims = !opts || opts.includeSims !== false;
  const course = state.cachedCourseMap[courseKey];
  if (!course) return null;

  const weights = Array.isArray(course.resources && course.resources.gradeWeights)
    ? course.resources.gradeWeights : null;

  const items = getCourseItems(courseKey, { includeSims });

  // ---- the items themselves -------------------------------------------------
  let earned = 0;
  let gradedPossible = 0;
  let openPoints = 0;
  let openCount = 0;
  let taskTotal = 0;
  items.forEach(it => {
    if (!(it.points > 0)) return;
    taskTotal += it.points;
    if (it.earned !== null && it.earned !== undefined) {
      earned += it.earned;
      gradedPossible += it.points;
    } else {
      openPoints += it.points;
      openCount += 1;
    }
  });

  // ---- syllabus weights -----------------------------------------------------
  const weightByCat = {};
  if (weights) {
    weights.forEach(w => {
      const cat = categorizeText(w.label);
      weightByCat[cat] = (weightByCat[cat] || 0) + (Number(w.pct) || 0);
    });
  }

  const catStats = {};
  items.forEach(it => {
    const cat = it.category;
    if (!catStats[cat]) catStats[cat] = { earned: 0, gradedPossible: 0, openPoints: 0, weight: 0 };
    const st = catStats[cat];
    if (it.earned !== null && it.earned !== undefined) {
      st.earned += it.earned;
      st.gradedPossible += it.points;
    } else {
      st.openPoints += it.points;
    }
  });
  Object.keys(weightByCat).forEach(cat => {
    if (catStats[cat]) catStats[cat].weight = weightByCat[cat];
  });

  let floorPoints = 0;
  let gainPoints = 0;
  let soFarPoints = 0;
  let soFarWeight = 0;
  Object.keys(catStats).forEach(cat => {
    const st = catStats[cat];
    if (!st.weight) return;
    const denom = st.gradedPossible + st.openPoints;
    if (denom > 0) {
      floorPoints += st.weight * (st.earned / denom);
      gainPoints += st.weight * (st.openPoints / denom);
    }
    if (st.gradedPossible > 0) {
      soFarPoints += st.weight * (st.earned / st.gradedPossible);
      soFarWeight += st.weight;
    }
  });

  // The syllabus breakdown is only trusted once enough of the grade has
  // actually been scored — the same threshold the old calculator used.
  const weightedUsable = !!(weights && weights.length) && soFarWeight >= 10;
  const weighted = weightedUsable;

  const equalTotalPossible = Math.max(taskTotal, gradedPossible);
  const equalSoFar = gradedPossible > 0 ? (earned / gradedPossible) * 100 : null;
  const equalFloor = equalTotalPossible > 0 ? (earned / equalTotalPossible) * 100 : null;
  const equalGain = equalTotalPossible > 0 ? ((equalTotalPossible - gradedPossible) / equalTotalPossible) * 100 : null;

  const weightedSoFar = soFarWeight > 0 ? (soFarPoints / soFarWeight) * 100 : null;

  const soFarPct = weighted ? weightedSoFar : equalSoFar;
  const floorPct = weighted ? floorPoints : equalFloor;
  const gainPct = weighted ? gainPoints : equalGain;

  return {
    courseKey,
    courseName: (course.name || '').trim(),
    weights: weights || null,
    weighted,
    weightByCat,
    catStats,
    items,
    // Grade so far — ungraded work excluded, exactly like Canvas.
    soFarPct: soFarPct === null ? null : round1(soFarPct),
    // The floor (open work scored 0) and the headroom (per 1% on open work).
    floorPct: floorPct === null ? null : round1(floorPct),
    gainPct: gainPct === null ? null : round1(gainPct),
    // The assumption used by "the rest lands here": your current average.
    avgPct: soFarPct === null ? null : round1(soFarPct),
    gradedPossible,
    earned,
    totalPossible: equalTotalPossible,
    openPoints,
    openCount,
  };
}

// ---------------------------------------------------------------------------
//  TARGETS
// ---------------------------------------------------------------------------

// What % do you need on the work that is still open to reach `targetPct`?
//   state 'ok'          — reachable, pct is the score you need
//   state 'locked'      — you already have it, even at 0% on the rest
//   state 'unreachable' — even 100% on the rest is not enough
//   state 'unknown'     — nothing to go on yet
export function needForTarget(model, targetPct) {
  if (!model || targetPct === null || targetPct === undefined) return { state: 'unknown' };
  if (model.gainPct === null || model.gainPct <= 0) {
    if (model.floorPct !== null && model.floorPct >= targetPct) return { state: 'locked', pct: 0 };
    return { state: 'unreachable', pct: null };
  }
  if (model.floorPct === null) return { state: 'unknown' };
  const q = (targetPct - model.floorPct) / model.gainPct;
  if (q <= 0) return { state: 'locked', pct: 0 };
  if (q > 1) return { state: 'unreachable', pct: round1(q * 100) };
  return { state: 'ok', pct: round1(q * 100) };
}

// ---------------------------------------------------------------------------
//  THE FINAL
// ---------------------------------------------------------------------------

// Pulls the course's final out of its item list: prefers a real exam
// ("Final Exam", "Comprehensive Final", a bare trailing "Final") over Final
// Projects that merely share the word, then falls back to the largest
// 'final'-category item with points. Only items that are still OPEN (not
// graded, not simulated) can be a final you still have to sit.
function findFinalItem(items) {
  const open = items.filter(it => !it.orphan && it.points > 0 && (it.earned === null || it.earned === undefined));
  if (!open.length) return null;
  const examLike = open.filter(it =>
    /\bfinal\s*exams?\b|\bcomprehensive\s+final\b|\bfinal\s*$/i.test(String(it.title).trim()));
  if (examLike.length) return examLike.sort((a, b) => b.points - a.points)[0];
  const finalCat = open.filter(it => it.category === 'final');
  if (finalCat.length) return finalCat.sort((a, b) => b.points - a.points)[0];
  return null;
}

// "What do I need on the final?" — isolates the final and solves for the %
// needed ON THAT ITEM to reach a letter, holding the rest of the open work
// at your current average.
//
// Returns { finalName, worthLabel, needPct, state } for one target, or null
// when the course has no identifiable final yet.
export function finalNeedForTarget(model, targetPct) {
  if (!model) return null;
  const finalItem = findFinalItem(model.items);
  if (!finalItem) return null;

  // How much of the grade the final is worth, and how much of `gainPct` it
  // controls.
  let worthLabel;
  let finalGain;
  if (model.weighted) {
    const cat = model.catStats[finalItem.category];
    const w = (cat && cat.weight) || 0;
    if (!w) return null;
    const denom = (cat.gradedPossible || 0) + (cat.openPoints || 0);
    finalGain = denom > 0 ? w * (finalItem.points / denom) : 0;
    worthLabel = `${w}% of the grade`;
  } else {
    if (!(model.totalPossible > 0)) return null;
    finalGain = (finalItem.points / model.totalPossible) * 100;
    worthLabel = `${finalItem.points} pts`;
  }
  if (!(finalGain > 0)) return null;

  const rest = Math.max(0, (model.gainPct || 0) - finalGain);
  const r = model.avgPct === null ? 0 : model.avgPct / 100;
  const base = (model.floorPct || 0) + rest * r;
  const f = (targetPct - base) / finalGain;

  const out = { finalName: finalItem.title, worthLabel, finalGain };
  if (f <= 0) { out.state = 'locked'; out.pct = 0; return out; }
  if (f > 1) { out.state = 'unreachable'; out.pct = round1(f * 100); return out; }
  out.state = 'ok';
  out.pct = round1(f * 100);
  return out;
}

// ---------------------------------------------------------------------------
//  LEGACY PROJECTION HELPERS
//  (the course summary cards and the simulator both read from these)
// ---------------------------------------------------------------------------

// The syllabus-weighted "grade so far", or null when the course has no
// usable weights or too little of the grade is graded to trust them.
export function computeWeightedCoursePct(courseKey, opts) {
  const model = buildCourseModel(courseKey, opts);
  if (!model || !model.weighted) return null;
  return model.soFarPct;
}

// Full projection for one course:
//   - weights:      the syllabus breakdown [{label, pct}] or null
//   - weighted:     whether the weighted model was used
//   - weightedPct:  weighted grade-so-far (null when unusable)
//   - graded:       whether any graded/simulated work exists
//   - hasRemaining: whether ungraded work remains to project against
//   - needed:       [{letter, min, pct}] the % needed on that remaining work
//                   to reach each tier, high-to-low, only tiers that are
//                   still feasible.
export function computeCourseProjection(courseKey, opts) {
  const model = buildCourseModel(courseKey, opts);
  if (!model) return null;

  const needed = model.gainPct > 0
    ? LETTER_TIERS
      .map(t => ({ letter: t.letter, min: t.min, pct: round1(((t.min - model.floorPct) / model.gainPct) * 100) }))
      .filter(n => n.pct > 0 && n.pct < 100)
    : [];

  return {
    weights: model.weights,
    weighted: model.weighted,
    weightedPct: model.weighted ? model.soFarPct : null,
    graded: model.soFarPct !== null,
    hasRemaining: model.gainPct > 0,
    needed,
  };
}

// The "what do I need on the final?" list, for every letter tier.
export function computeFinalExamNeeds(courseKey, opts) {
  const model = buildCourseModel(courseKey, opts);
  if (!model) return null;
  const finalItem = findFinalItem(model.items);
  if (!finalItem) return null;

  let worthLabel;
  let finalGain;
  if (model.weighted) {
    const cat = model.catStats[finalItem.category];
    const w = (cat && cat.weight) || 0;
    if (!w) return null;
    const denom = (cat.gradedPossible || 0) + (cat.openPoints || 0);
    finalGain = denom > 0 ? w * (finalItem.points / denom) : 0;
    worthLabel = `${w}% of the grade`;
  } else {
    if (!(model.totalPossible > 0)) return null;
    finalGain = (finalItem.points / model.totalPossible) * 100;
    worthLabel = `${finalItem.points} pts`;
  }
  if (!(finalGain > 0)) return null;

  const rest = Math.max(0, (model.gainPct || 0) - finalGain);
  const r = model.avgPct === null ? 0 : model.avgPct / 100;
  const base = (model.floorPct || 0) + rest * r;

  const needs = LETTER_TIERS
    .map(t => ({ letter: t.letter, min: t.min, pct: round1(((t.min - base) / finalGain) * 100) }))
    .filter(n => n.pct > 0 && n.pct < 100);

  return {
    finalName: finalItem.title,
    worthLabel,
    needs,
  };
}
