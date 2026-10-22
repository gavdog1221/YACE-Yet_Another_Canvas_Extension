import { state } from '../state.js';
import { saveWhatIfScores } from '../storage/caches.js';
import { getCourseColors } from '../utils/colors.js';
import { formatScoreNum, percentageToGpa } from '../utils/grades.js';
import { buildCourseModel, finalNeedForTarget, needForTarget } from '../utils/grade-projections.js';
import { LETTER_TIERS, categorizeText, getCourseSims, pruneStaleSimulations } from '../utils/grade-core.js';

// ---------------------------------------------------------------------------
//  GRADE SIMULATOR
//
//  "What if I get X on this?" — answered without leaving the Grades panel.
//
//  The shape of it:
//    · one line per course with the grade you have now, the grade your
//      scenarios produce, and the difference between them,
//    · the price of the target letter ("93% on what's left for an A"),
//    · one row per assignment still to be graded, with a percentage box.
//
//  Everything updates in place while you type: the old simulator rebuilt the
//  whole Grades panel on every keystroke and then hunted for the input to
//  put the caret back in. Nothing is rebuilt here, so the caret never moves.
//
//  The number you type is a PERCENTAGE ("92" = 92% of the points), because
//  that is how people think about a grade. The points it works out to is
//  shown next to it.
// ---------------------------------------------------------------------------

const TARGET_LETTERS = LETTER_TIERS.map(t => t.letter);

const DATE_FMT = { month: 'short', day: 'numeric' };

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${Math.round(n * 10) / 10}%`;
}

function fmtDelta(n) {
  const v = Math.round(n * 10) / 10;
  if (!v) return '0';
  return v > 0 ? `+${v}` : `${v}`;
}

// The letter a percentage lands on, plus the tier class that colours it.
function letterFor(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return { letter: '—', gpa: null, tier: 'tier-none' };
  const info = percentageToGpa(pct);
  const tier = pct >= 90 ? 'tier-a' : pct >= 80 ? 'tier-b' : pct >= 70 ? 'tier-c' : pct >= 60 ? 'tier-d' : 'tier-f';
  return { letter: info.letter, gpa: info.gpa, tier };
}

// An assignment the student can still put a hypothetical score on: it has
// points, it belongs to the course map, and Canvas has not posted a real
// score for it. A simulated score does NOT remove it from this list — the
// row stays so the scenario can be seen and edited.
function assignableItems(model) {
  return model.items.filter(it => it.id && !(it.earned !== null && it.earned !== undefined && !it.simulated));
}

export function createGradeSimulator(opts) {
  const hiddenCourses = (opts && opts.hiddenCourses) || [];
  const onChange = (opts && opts.onChange) || (() => {});

  const root = document.createElement('div');
  root.className = 'sim-card';

  // ---- header --------------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'sim-head';
  head.innerHTML = `
    <button type="button" class="sim-toggle" aria-expanded="false">
      <span class="sim-chevron" aria-hidden="true">▸</span>
      <span class="sim-heading">⚡ Grade Simulator</span>
      <span class="sim-summary"></span>
    </button>
    <div class="sim-head-tools">
      <label class="sim-target" title="The grade you are aiming for">
        <span class="sim-target-label">Aim for</span>
        <select class="sim-target-select" aria-label="Target grade">${TARGET_LETTERS.map(l => `<option value="${l}">${l}</option>`).join('')}</select>
      </label>
      <button type="button" class="sim-reset-all" title="Remove every scenario">Reset all</button>
    </div>
  `;
  root.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sim-body';
  root.appendChild(body);

  const targetSelect = head.querySelector('.sim-target-select');
  targetSelect.value = state.whatIfTarget || 'A';
  targetSelect.addEventListener('change', () => {
    state.whatIfTarget = targetSelect.value;
    refresh();
  });

  const toggleBtn = head.querySelector('.sim-toggle');
  toggleBtn.addEventListener('click', () => {
    state.whatIfExpanded = !state.whatIfExpanded;
    applyExpanded();
  });

  const resetAllBtn = head.querySelector('.sim-reset-all');
  resetAllBtn.addEventListener('click', () => {
    if (!Object.keys(state.whatIfScores).length) return;
    state.whatIfScores = {};
    saveWhatIfScores();
    refresh();
    onChange();
  });

  function applyExpanded() {
    root.classList.toggle('is-collapsed', !state.whatIfExpanded);
    toggleBtn.setAttribute('aria-expanded', state.whatIfExpanded ? 'true' : 'false');
    const chevron = toggleBtn.querySelector('.sim-chevron');
    if (chevron) chevron.textContent = state.whatIfExpanded ? '▾' : '▸';
  }

  // ---- per-course blocks ---------------------------------------------------
  // Each block keeps its own references so a keystroke can update the
  // numbers without rebuilding anything.
  const blocks = [];
  let builtSignature = '';

  // The courses worth showing: visible, matching the active filter, and
  // with at least one assignment still to be graded.
  function simulatorCourses() {
    const out = [];
    Object.entries(state.cachedCourseMap).forEach(([cKey]) => {
      if (hiddenCourses.includes(cKey)) return;
      if (state.activeCourseFilter !== 'ALL' && state.activeCourseFilter !== cKey) return;
      const course = state.cachedCourseMap[cKey];
      const hasOpen = ((course && course.tasks) || []).some(t => t.points && t.points > 0);
      if (!hasOpen) return;
      out.push(cKey);
    });
    out.sort();
    return out;
  }

  function courseSignature(keys) {
    return keys.map(k => {
      const course = state.cachedCourseMap[k] || {};
      const n = (course.tasks || []).filter(t => t.points && t.points > 0).length;
      return `${k}:${n}`;
    }).join('|');
  }

  function buildBlock(courseKey) {
    const el = document.createElement('div');
    el.className = 'sim-course';
    el.dataset.course = courseKey;
    const palette = getCourseColors(courseKey, (state.cachedCourseMap[courseKey] || {}).canvasCourseId);
    el.style.setProperty('--sim-accent', palette.accent);
    el.style.setProperty('--sim-soft', palette.soft);

    el.innerHTML = `
      <div class="sim-course-head">
        <div class="sim-course-id">
          <span class="sim-course-key"></span>
          <span class="sim-course-name"></span>
        </div>
        <div class="sim-course-score">
          <span class="sim-score-prev"></span>
          <span class="sim-score-arrow" aria-hidden="true">→</span>
          <span class="sim-score-now"></span>
          <span class="sim-delta"></span>
          <span class="sim-letter"></span>
        </div>
      </div>
      <div class="sim-bar" aria-hidden="true">
        <div class="sim-bar-fill"></div>
        <div class="sim-bar-now"></div>
        <div class="sim-bar-target"></div>
      </div>
      <div class="sim-notes">
        <div class="sim-note sim-note-target"></div>
        <div class="sim-note sim-note-final"></div>
      </div>
      <div class="sim-course-actions">
        <button type="button" class="sim-action sim-action-fill"></button>
        <button type="button" class="sim-action sim-action-perfect" title="Score 100% on everything that is left">All perfect</button>
        <button type="button" class="sim-action sim-action-reset" title="Remove this course's scenarios">Reset</button>
      </div>
      <div class="sim-items"></div>
    `;

    const refs = {
      courseKey,
      el,
      rowSig: null,
      key: el.querySelector('.sim-course-key'),
      name: el.querySelector('.sim-course-name'),
      prev: el.querySelector('.sim-score-prev'),
      arrow: el.querySelector('.sim-score-arrow'),
      now: el.querySelector('.sim-score-now'),
      delta: el.querySelector('.sim-delta'),
      letter: el.querySelector('.sim-letter'),
      barFill: el.querySelector('.sim-bar-fill'),
      barNow: el.querySelector('.sim-bar-now'),
      barTarget: el.querySelector('.sim-bar-target'),
      noteTarget: el.querySelector('.sim-note-target'),
      noteFinal: el.querySelector('.sim-note-final'),
      fillBtn: el.querySelector('.sim-action-fill'),
      perfectBtn: el.querySelector('.sim-action-perfect'),
      resetBtn: el.querySelector('.sim-action-reset'),
      itemsEl: el.querySelector('.sim-items'),
      items: [],
    };

    refs.key.textContent = courseKey;
    const courseName = ((state.cachedCourseMap[courseKey] || {}).name || '').trim();
    refs.name.textContent = courseName;
    refs.name.title = courseName;
    refs.name.style.display = courseName ? '' : 'none';

    refs.fillBtn.addEventListener('click', () => fillForTarget(courseKey));
    refs.perfectBtn.addEventListener('click', () => fillAll(courseKey, 100));
    refs.resetBtn.addEventListener('click', () => resetCourse(courseKey));

    return refs;
  }

  // One row per assignment still to be graded.
  function buildItems(refs, model) {
    refs.itemsEl.innerHTML = '';
    refs.items = [];

    assignableItems(model).forEach(item => {
      const row = document.createElement('div');
      row.className = 'sim-item';
      row.dataset.taskId = item.id;

      const metaBits = [];
      if (item.dueDate) {
        const d = item.dueDate instanceof Date ? item.dueDate : new Date(item.dueDate);
        if (!isNaN(d.getTime())) metaBits.push(`due ${d.toLocaleDateString(undefined, DATE_FMT)}`);
      }
      metaBits.push(`${formatScoreNum(item.points)} pts`);
      const catWeight = model.weightByCat && model.weightByCat[item.category];
      let weightTip = '';
      if (catWeight) {
        const entry = (model.weights || []).find(w => categorizeText(w.label) === item.category);
        const w = Math.round(catWeight * 10) / 10;
        metaBits.push(`${w}% of grade`);
        weightTip = entry ? `${entry.label}: ${w}% of the final grade` : `${w}% of the final grade`;
      }

      const metaEl = document.createElement('span');
      metaEl.className = 'sim-item-meta';
      metaEl.textContent = metaBits.join(' · ');
      if (weightTip) metaEl.title = weightTip;

      const infoEl = document.createElement('div');
      infoEl.className = 'sim-item-info';
      const titleEl = document.createElement('span');
      titleEl.className = 'sim-item-title';
      titleEl.textContent = item.title;
      titleEl.title = item.title;
      infoEl.appendChild(titleEl);
      infoEl.appendChild(metaEl);

      const ctlEl = document.createElement('div');
      ctlEl.className = 'sim-item-ctl';
      const wrapEl = document.createElement('div');
      wrapEl.className = 'sim-input-wrap';
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sim-input';
      input.min = '0';
      input.max = '100';
      input.step = '0.5';
      input.inputMode = 'decimal';
      input.placeholder = '–';
      input.setAttribute('aria-label', `Simulated score for ${item.title}`);
      const unitEl = document.createElement('span');
      unitEl.className = 'sim-input-unit';
      unitEl.setAttribute('aria-hidden', 'true');
      unitEl.textContent = '%';
      wrapEl.appendChild(input);
      wrapEl.appendChild(unitEl);
      const ptsEl = document.createElement('span');
      ptsEl.className = 'sim-item-pts';
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'sim-item-reset';
      resetBtn.title = 'Remove this scenario';
      resetBtn.setAttribute('aria-label', `Remove the scenario for ${item.title}`);
      resetBtn.textContent = '×';
      ctlEl.appendChild(wrapEl);
      ctlEl.appendChild(ptsEl);
      ctlEl.appendChild(resetBtn);

      row.appendChild(infoEl);
      row.appendChild(ctlEl);

      const rowRef = { item, row, input, ptsEl, resetBtn };

      input.addEventListener('input', (e) => {
        const raw = e.target.value;
        if (raw === '' || raw === null || raw === undefined) {
          if (state.whatIfScores[item.id]) {
            delete state.whatIfScores[item.id];
            saveWhatIfScores();
            refresh();
            onChange();
          }
          return;
        }
        const pct = parseFloat(raw);
        if (isNaN(pct)) return;
        const clamped = Math.max(0, Math.min(100, pct));
        state.whatIfScores[item.id] = {
          score: item.points * clamped / 100,
          pct: clamped,
          pointsPossible: item.points,
          courseKey: refs.courseKey,
        };
        saveWhatIfScores();
        refresh();
        onChange();
      });

      // Normalise what was typed once the field is done with (a stray
      // "95.5" or a value over 100 becomes a clean number).
      input.addEventListener('change', () => {
        const sim = state.whatIfScores[item.id];
        if (!sim) { input.value = ''; return; }
        const clean = Math.max(0, Math.min(100, parseFloat(sim.pct) || 0));
        input.value = String(clean);
      });

      resetBtn.addEventListener('click', () => {
        if (!state.whatIfScores[item.id]) return;
        delete state.whatIfScores[item.id];
        saveWhatIfScores();
        refresh();
        onChange();
      });

      refs.itemsEl.appendChild(row);
      refs.items.push(rowRef);
    });

    if (!refs.items.length) {
      const empty = document.createElement('div');
      empty.className = 'sim-empty';
      empty.textContent = 'Nothing left to grade in this course.';
      refs.itemsEl.appendChild(empty);
    }
  }

  // ---- actions -------------------------------------------------------------

  // Set every open assignment to the score that lands the course exactly on
  // the target letter. The model is linear, so one number does it for the
  // whole course.
  function fillForTarget(courseKey) {
    const model = buildCourseModel(courseKey);
    if (!model) return;
    const need = needForTarget(model, targetPct());
    if (need.state !== 'ok') return;
    applyPctToOpen(model, need.pct);
  }

  function fillAll(courseKey, pct) {
    const model = buildCourseModel(courseKey);
    if (!model) return;
    applyPctToOpen(model, pct);
  }

  // Put one score on everything that is still OPEN.
  //
  // Only open work is touched. Work that already carries a scenario keeps it:
  // the "need" figure the model produced already accounts for those
  // scenarios, so overwriting them would change the base the answer was
  // calculated against.
  function applyPctToOpen(model, pct) {
    let touched = false;
    model.items.forEach(item => {
      if (!item.id) return;
      if (item.earned !== null && item.earned !== undefined) return;
      state.whatIfScores[item.id] = {
        score: item.points * pct / 100,
        pct,
        pointsPossible: item.points,
        courseKey: model.courseKey,
      };
      touched = true;
    });
    if (!touched) return;
    saveWhatIfScores();
    refresh();
    onChange();
  }

  function resetCourse(courseKey) {
    const ids = Object.keys(getCourseSims(courseKey));
    if (!ids.length) return;
    ids.forEach(id => { delete state.whatIfScores[id]; });
    saveWhatIfScores();
    refresh();
    onChange();
  }

  function targetPct() {
    const tier = LETTER_TIERS.find(t => t.letter === (state.whatIfTarget || 'A'));
    return tier ? tier.min : 93;
  }

  // ---- rendering -----------------------------------------------------------

  // Full rebuild: only when the set of courses or their assignments changed.
  function render() {
    const keys = simulatorCourses();
    builtSignature = courseSignature(keys);
    body.innerHTML = '';
    blocks.length = 0;

    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'sim-empty';
      empty.textContent = 'No ungraded assignments to simulate.';
      body.appendChild(empty);
      return;
    }

    keys.forEach(key => {
      const refs = buildBlock(key);
      blocks.push(refs);
      body.appendChild(refs.el);
    });
  }

  // In-place update: the numbers move, nothing is rebuilt.
  function refresh() {
    const keys = simulatorCourses();
    if (courseSignature(keys) !== builtSignature) render();

    const target = targetPct();
    const targetLetter = state.whatIfTarget || 'A';
    let simCount = 0;

    blocks.forEach(refs => {
      const courseKey = refs.courseKey;
      const withSims = buildCourseModel(courseKey);
      const plain = buildCourseModel(courseKey, { includeSims: false });
      if (!withSims) return;

      // Rows are built from the model; rebuild them only when the set of
      // assignments changed (a rescan), never while typing.
      const rowSig = assignableItems(withSims).map(i => `${i.id}:${i.points}`).join(',');
      if (refs.rowSig !== rowSig) {
        refs.rowSig = rowSig;
        buildItems(refs, withSims);
      }

      const nowPct = withSims.soFarPct;
      const prevPct = plain ? plain.soFarPct : null;
      const base = prevPct === null ? 0 : prevPct;
      const hasSim = nowPct !== null && Math.abs(nowPct - base) > 0.05;

      const nowLetter = letterFor(nowPct);
      refs.el.className = `sim-course ${nowLetter.tier}`;
      refs.now.textContent = fmtPct(nowPct);
      refs.letter.textContent = nowLetter.letter;
      refs.prev.textContent = hasSim && prevPct !== null ? fmtPct(prevPct) : '';
      refs.arrow.style.display = hasSim ? '' : 'none';
      refs.delta.textContent = hasSim ? fmtDelta(nowPct - base) : '';
      refs.delta.className = `sim-delta ${hasSim ? (nowPct > base ? 'is-up' : 'is-down') : ''}`;
      refs.delta.style.display = hasSim ? '' : 'none';

      // Bar: the grade the scenarios produce, a tick where you are now and
      // another where the target sits.
      const barPct = Math.max(0, Math.min(100, nowPct === null ? 0 : nowPct));
      refs.barFill.style.width = `${barPct}%`;
      if (hasSim && prevPct !== null) {
        refs.barNow.style.display = '';
        refs.barNow.style.left = `${Math.max(0, Math.min(100, prevPct))}%`;
      } else {
        refs.barNow.style.display = 'none';
      }
      refs.barTarget.style.display = '';
      refs.barTarget.style.left = `${target}%`;
      refs.barTarget.title = `Target: ${targetLetter} (${target}%)`;

      // The two "what do I need" lines.
      const need = needForTarget(withSims, target);
      renderTargetNote(refs, need, targetLetter, withSims);
      const finalNeed = finalNeedForTarget(withSims, target);
      renderFinalNote(refs, finalNeed, targetLetter);

      // Buttons.
      if (need.state === 'ok') {
        refs.fillBtn.textContent = `Fill ${need.pct}% for ${targetLetter}`;
        refs.fillBtn.disabled = false;
        refs.fillBtn.removeAttribute('title');
      } else {
        refs.fillBtn.textContent = need.state === 'locked'
          ? `${targetLetter} already secured`
          : `${targetLetter} out of reach`;
        refs.fillBtn.disabled = true;
        refs.fillBtn.title = need.state === 'unreachable'
          ? `Even 100% on everything left is not enough for a ${targetLetter}`
          : `Your remaining work already secures a ${targetLetter}`;
      }
      const courseSimCount = Object.keys(getCourseSims(courseKey)).length;
      simCount += courseSimCount;
      refs.resetBtn.disabled = courseSimCount === 0;
      refs.perfectBtn.disabled = withSims.openCount === 0;

      // Rows.
      refs.items.forEach(rowRef => {
        const sim = state.whatIfScores[rowRef.item.id];
        const has = !!sim;
        rowRef.row.classList.toggle('is-sim', has);
        if (has) {
          const pct = typeof sim.pct === 'number'
            ? sim.pct
            : (sim.pointsPossible ? (sim.score / sim.pointsPossible) * 100 : 0);
          if (document.activeElement !== rowRef.input) rowRef.input.value = String(Math.round(pct * 10) / 10);
          rowRef.ptsEl.textContent = `${formatScoreNum(sim.score)}/${formatScoreNum(rowRef.item.points)}`;
          rowRef.ptsEl.classList.add('is-sim');
        } else {
          if (document.activeElement !== rowRef.input) rowRef.input.value = '';
          rowRef.ptsEl.textContent = `—/${formatScoreNum(rowRef.item.points)}`;
          rowRef.ptsEl.classList.remove('is-sim');
        }
        rowRef.resetBtn.style.display = has ? '' : 'none';
      });
    });

    // Header summary.
    const summary = head.querySelector('.sim-summary');
    if (summary) {
      summary.textContent = simCount
        ? `· ${simCount} scenario${simCount === 1 ? '' : 's'}`
        : '· type a score to see the impact';
    }
    resetAllBtn.disabled = simCount === 0;
  }

  function renderTargetNote(refs, need, targetLetter, model) {
    const el = refs.noteTarget;
    if (!need || need.state === 'unknown') {
      el.textContent = 'Add a score below and the numbers come alive.';
      el.className = 'sim-note sim-note-target is-muted';
      return;
    }
    if (need.state === 'locked') {
      el.textContent = `🎉 A ${targetLetter} is already secured — the rest cannot take it away.`;
      el.className = 'sim-note sim-note-target is-good';
      return;
    }
    if (need.state === 'unreachable') {
      el.textContent = `⚠️ A ${targetLetter} is out of reach — it would take ${need.pct}% on what's left.`;
      el.className = 'sim-note sim-note-target is-bad';
      return;
    }
    const count = model.openCount;
    const pts = model.openPoints;
    el.textContent = `🎯 For a ${targetLetter}: ${need.pct}% on the ${count} assignment${count === 1 ? '' : 's'} left (${formatScoreNum(pts)} pts).`;
    el.className = 'sim-note sim-note-target is-good';
  }

  function renderFinalNote(refs, finalNeed, targetLetter) {
    const el = refs.noteFinal;
    if (!finalNeed) {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    if (finalNeed.state === 'locked') {
      el.textContent = `🧪 ${finalNeed.finalName} (${finalNeed.worthLabel}): your ${targetLetter} is already safe.`;
      el.className = 'sim-note sim-note-final is-good';
      return;
    }
    if (finalNeed.state === 'unreachable') {
      el.textContent = `🧪 ${finalNeed.finalName} (${finalNeed.worthLabel}): a ${targetLetter} would need ${finalNeed.pct}% — out of reach.`;
      el.className = 'sim-note sim-note-final is-bad';
      return;
    }
    el.textContent = `🧪 ${finalNeed.finalName} (${finalNeed.worthLabel}): ${finalNeed.pct}% for a ${targetLetter}, if the rest lands at your average.`;
    el.className = 'sim-note sim-note-final';
  }

  // ---- boot ----------------------------------------------------------------

  // Scenarios whose assignment has since been graded would add phantom points
  // to the course percentage, so they are dropped once, on open.
  if (pruneStaleSimulations()) saveWhatIfScores();

  render();
  refresh();
  applyExpanded();

  return {
    element: root,
    refresh,
  };
}
