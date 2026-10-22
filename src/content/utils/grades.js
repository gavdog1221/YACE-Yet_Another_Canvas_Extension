import { state } from '../state.js';
import { buildCourseModel } from '../utils/grade-projections.js';

export function percentageToGpa(pct) {
    if (pct >= 93) return { gpa: 4.0, letter: 'A' };
    if (pct >= 90) return { gpa: 3.7, letter: 'A-' };
    if (pct >= 87) return { gpa: 3.3, letter: 'B+' };
    if (pct >= 83) return { gpa: 3.0, letter: 'B' };
    if (pct >= 80) return { gpa: 2.7, letter: 'B-' };
    if (pct >= 77) return { gpa: 2.3, letter: 'C+' };
    if (pct >= 73) return { gpa: 2.0, letter: 'C' };
    if (pct >= 70) return { gpa: 1.7, letter: 'C-' };
    if (pct >= 67) return { gpa: 1.3, letter: 'D+' };
    if (pct >= 60) return { gpa: 1.0, letter: 'D' };
    return { gpa: 0.0, letter: 'F' };
  }

export function gradeTierClass(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return 'tier-none';
    if (pct >= 90) return 'tier-a';
    if (pct >= 80) return 'tier-b';
    if (pct >= 70) return 'tier-c';
    if (pct >= 60) return 'tier-d';
    return 'tier-f';
  }

export function formatScoreNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  }

// The course percentage for every visible course, with the what-if
// scenarios folded in.
//
// The number is the "grade so far": it counts the work that HAS a score
// (posted or simulated) and leaves the still-open work out, exactly like
// Canvas does. A simulation on an assignment that has since been graded
// REPLACES the posted score instead of being added on top of it — the old
// calculator summed the two and double counted anything that had come back
// in the meantime.
export function computeCoursePercentagesWithWhatIf(hiddenCourses) {
    const activeKeys = Object.keys(state.cachedCourseMap).filter(k => !hiddenCourses.includes(k));
    const result = {};

    activeKeys.forEach(cKey => {
      const model = buildCourseModel(cKey);
      if (model && model.soFarPct !== null) {
        result[cKey] = model.soFarPct;
        return;
      }
      if (state.cachedCoursePercentages[cKey] !== undefined && state.cachedCoursePercentages[cKey] !== null) {
        result[cKey] = state.cachedCoursePercentages[cKey];
      } else {
        result[cKey] = null;
      }
    });

    return result;
  }
