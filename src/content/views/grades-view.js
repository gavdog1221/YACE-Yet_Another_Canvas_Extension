import { state } from '../state.js';
import { applyGradeWeightChoice } from '../storage/caches.js';
import { getCourseColors, parseColorToRgba } from '../utils/colors.js';
import { computeCourseProjection, computeFinalExamNeeds } from '../utils/grade-projections.js';
import { computeCoursePercentagesWithWhatIf, formatScoreNum, gradeTierClass, percentageToGpa } from '../utils/grades.js';
import { escapeHTML } from '../utils/text.js';
import { applyCourseFilter } from '../views/upcoming-view.js';
import { openCanvasViewer } from '../components/canvas-viewer.js';
import { createGradeSimulator } from '../components/grade-simulator.js';

export function updateGradeChangeBadge() {
    const badge = document.getElementById('grades-change-badge');
    if (!badge) return;
    const count = (state.gradeChangeAlerts || []).length;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
    badge.innerText = count;
  }

// Which courses currently have their recent-grade column expanded. Module-level
// (the same trick dashboard-view.js uses for its in-flight dragOrder) so the
// choice survives the full-panel re-renders below — otherwise the first what-if
// keystroke would quietly collapse everything the user just opened. Deliberately
// NOT persisted: a page reload starts from the tidy all-collapsed view.
const expandedCourses = new Set();

// Flip one course's recent-grade column between the peek (the first RECENT_PEEK
// rows, which are always visible) and the full RECENT_PER_COURSE. Intentionally
// does NOT re-render the panel: a full rebuild throws away the caret in whatever
// what-if input the user may be typing into, and this toggle only has to touch
// three things — the block's state class, the button's aria state and its label.
function flipRecentColumn(courseKey, block, toggle) {
    const open = !expandedCourses.has(courseKey);
    if (open) expandedCourses.add(courseKey);
    else expandedCourses.delete(courseKey);
    block.classList.toggle('is-recent-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.querySelector('.course-recent-chevron').textContent = open ? '▾' : '▸';
    toggle.querySelector('.course-recent-toggle-label').textContent = open ? 'Show less' : 'Show all';
}

// How many of a course's graded submissions to list when its column is opened.
// The panel is tall but not endless, and one course with thirty submissions must
// not bury the other courses — the remainder is summarised as a "+N older" line
// rather than hidden silently.
const RECENT_PER_COURSE = 5;

// How many rows a course's list shows with NO clicking at all. Every list
// starting hidden was the panel's real usability bug: six courses, six clicks
// before it said anything about grades. Three compact one-line rows answer
// "how am I doing and what just came back" at a glance, and the toggle then
// reveals the rest of that course's history.
const RECENT_PEEK = 3;

// The syllabus weight breakdown as one proportional bar plus one line of text.
// This replaces a chip per weight, which on a half-width column wrapped onto two
// lines and was the single tallest thing on the card (43px of a 159px card) while
// saying nothing about the proportions. Descending alphas of the course accent
// keep it on-palette; the labels stay readable as plain text underneath.
//
function weightBarHtml(weights, accent) {
    const total = weights.reduce((n, w) => n + (Number(w.pct) || 0), 0);
    if (!total) return '';
    const ALPHAS = [0.92, 0.68, 0.48, 0.33, 0.22, 0.14];
    let at = 0;
    const stops = weights.map((w, i) => {
      const from = at;
      at += (Number(w.pct) || 0) / total * 100;
      const col = parseColorToRgba(accent, ALPHAS[i % ALPHAS.length]) || 'rgba(255,255,255,0.3)';
      // Zero-width hard stops are legal CSS, so an unknown weight won't break it.
      return `${col} ${from.toFixed(2)}% ${at.toFixed(2)}%`;
    });
    const legend = weights.map(w => `${escapeHTML(w.label)} ${w.pct}%`).join(' · ');
    const tip = weights.map(w => `${w.label}: ${w.pct}%`).join('\n');
    return `<div class="cg-weight-bar" style="background:linear-gradient(90deg, ${stops.join(', ')})" title="${escapeHTML(tip)}"></div>`
      + `<div class="cg-weight-legend"><span class="cg-weight-text">${legend}</span></div>`;
  }

// The graded submissions belonging to each course, newest-graded first, keyed
// by courseKey so each column lines up with the course summary card above it.
// Replaces the standalone "Recent Grades" panel, which mixed every course into
// one undifferentiated feed. Entries with no gradedAt stamp sink to the bottom
// of their course's column (matching the old panel's ordering).
function recentByCourse(hiddenCourses) {
    const byCourse = new Map();
    (state.cachedGrades || []).forEach(g => {
      if (!g || hiddenCourses.includes(g.courseKey)) return;
      // A score is a number — 0 is a legitimately earned zero, not "ungraded".
      // Submitted-but-unscored entries would render as empty "✓" cards.
      if (typeof g.score !== 'number') return;
      if (!byCourse.has(g.courseKey)) byCourse.set(g.courseKey, []);
      byCourse.get(g.courseKey).push(g);
    });
    byCourse.forEach((list) => list.sort((a, b) => {
      if (a.gradedAt && b.gradedAt) return b.gradedAt - a.gradedAt;
      if (a.gradedAt) return -1;
      if (b.gradedAt) return 1;
      return 0;
    }));
    return byCourse;
}

// The moving parts of one course summary card: the percentage, the letter,
// the bar and the "need" line.
//
// It is a separate function so the simulator can call it again after a
// scenario changes the course percentage — the numbers move, the card is not
// rebuilt, and nothing steals the caret from the input being typed into.
//
// ONE need line, not two. "Need 92.3% on remaining for A" and
// "🎯 91.7% on the final for A" were rendered as sibling .cg-need-line rows
// on top of each other and read as a stutter. The final-exam figure is the
// actionable one so it takes the visible line; the overall figure moves into
// the tooltip rather than being dropped.
function applyCourseCardNumbers(refs, courseKey, pct) {
    if (!refs) return;
    const has = pct !== null && pct !== undefined && !isNaN(pct);

    if (has) {
      refs.percent.textContent = `${pct.toFixed(1)}%`;
      refs.percent.classList.remove('no-grade');
      refs.letter.textContent = percentageToGpa(pct).letter;
      refs.letter.style.display = '';
      refs.barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    } else {
      refs.percent.textContent = 'No grades yet';
      refs.percent.classList.add('no-grade');
      refs.letter.textContent = '';
      refs.letter.style.display = 'none';
      refs.barFill.style.width = '0%';
    }

    const proj = computeCourseProjection(courseKey);
    const needPct = proj && proj.needed.length > 0 ? proj.needed[0] : null;
    const finalNeed = computeFinalExamNeeds(courseKey);
    const finalPct = finalNeed && finalNeed.needs.length > 0 ? finalNeed.needs[0] : null;
    if (finalPct || needPct) {
      const tips = [];
      if (needPct) tips.push(`Score ~${needPct.pct}% on everything still ungraded for a ${needPct.letter}`);
      if (finalPct) tips.push(`On the ${finalNeed.finalName} (${finalNeed.worthLabel}): ~${finalNeed.needs.map(n => `${n.pct}% for ${n.letter}`).join(', ')}`);
      const text = finalPct
        ? `🎯 ${finalPct.pct}% on ${finalNeed.finalName} for ${finalPct.letter}`
        : `Need ${needPct.pct}% on remaining for ${needPct.letter}`;
      refs.needLine.textContent = text;
      refs.needLine.title = tips.join(' · ');
      refs.needLine.style.display = '';
    } else {
      refs.needLine.textContent = '';
      refs.needLine.title = '';
      refs.needLine.style.display = 'none';
    }
}

export function renderGradesView(listContainer, hiddenCourses, opts) {
    const withRecent = !!(opts && opts.recent);
    listContainer.innerHTML = '';
    // Every interactive re-render below (dismiss, weight picker, what-if input,
    // resets) recurses through here, so it has to carry `opts` — otherwise the
    // first click in the panel would quietly drop the per-course recent columns.
    const rerender = () => renderGradesView(listContainer, hiddenCourses, opts);

    const coursePcts = computeCoursePercentagesWithWhatIf(hiddenCourses);
    const courseCardsData = [];
    // The live-updatable pieces of each course summary card, keyed by course.
    const courseCardRefs = new Map();

    Object.entries(coursePcts).forEach(([cKey, pct]) => {
      if (pct !== null && !isNaN(pct)) {
        const info = percentageToGpa(pct);
        courseCardsData.push({ courseKey: cKey, pct: pct, letter: info.letter, hasGrade: true });
      } else {
        courseCardsData.push({ courseKey: cKey, pct: null, letter: '—', hasGrade: false });
      }
    });

    // Best-first ordering: graded courses ranked by score, ungraded ones
    // (nothing posted yet) pushed to the end instead of sitting wherever
    // Object.entries happened to iterate.
    courseCardsData.sort((a, b) => {
      if (a.hasGrade && b.hasGrade) return b.pct - a.pct;
      if (a.hasGrade) return -1;
      if (b.hasGrade) return 1;
      return a.courseKey.localeCompare(b.courseKey);
    });

    // GPA Header. The card is rendered empty and filled in by
    // refreshGradeNumbers() below, which is also what the simulator calls
    // after every scenario change — so the ring, the number and the
    // "What-If" flag all have exactly one place that knows how to set them.
    const gpaCard = document.createElement('div');
    gpaCard.className = 'gpa-card tier-none';
    gpaCard.innerHTML = `
    <div class="gpa-info-left">
    <span class="gpa-label">Current GPA<span class="gpa-whatif-flag" style="display:none">What-If</span></span>
    <span class="gpa-sub"></span>
    </div>
    <div class="gpa-ring-wrap">
    <div class="gpa-ring" style="--gpa-pct:0"></div>
    <div class="gpa-ring-value"></div>
    </div>
    `;
    listContainer.appendChild(gpaCard);

    // The parts of the GPA card a scenario has to move. Holding on to them
    // is what lets a what-if edit update the GPA live, instead of forcing a
    // full panel re-render (which used to eat the caret mid-keystroke).
    const gpaRefs = {
      card: gpaCard,
      flag: gpaCard.querySelector('.gpa-whatif-flag'),
      sub: gpaCard.querySelector('.gpa-sub'),
      ring: gpaCard.querySelector('.gpa-ring'),
      value: gpaCard.querySelector('.gpa-ring-value'),
    };

    // Grade-change alerts: new/changed scores since the last scan. Dismissible.
    if ((state.gradeChangeAlerts || []).length > 0) {
      const changeCard = document.createElement('div');
      changeCard.className = 'grade-changes-card';
      changeCard.innerHTML = `
      <div class="grade-changes-header">
      <span class="grade-changes-title">🔔 Grade updates</span>
      <button type="button" class="grade-changes-dismiss" id="grade-changes-dismiss" title="Dismiss">Dismiss</button>
      </div>
      ${state.gradeChangeAlerts.map(a => `
        <div class="grade-change-row">
        <span class="grade-change-course" title="${escapeHTML(a.courseName || a.courseKey)}">${escapeHTML(a.courseKey)}</span>
        <span class="grade-change-title">${escapeHTML(a.title)}</span>
        <span class="grade-change-delta">${a.isNew
          ? `posted ${formatScoreNum(a.score)}${a.pct !== null ? ` · ${a.pct.toFixed(0)}%` : ''}`
          : `${formatScoreNum(a.oldScore)} → ${formatScoreNum(a.score)}${a.pct !== null ? ` (${(a.oldPct || 0).toFixed(0)}% → ${a.pct.toFixed(0)}%)` : ''}`}</span>
        </div>`).join('')}
      `;
      const dismissBtn = changeCard.querySelector('#grade-changes-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          state.gradeChangeAlerts = [];
          updateGradeChangeBadge();
          rerender();
        });
      }
      listContainer.appendChild(changeCard);
    }

    // Course Summary Cards — clickable to filter the feedback list & the
    // what-if matrix down to just that course (mirrors the course pills).
    //
    // With opts.recent (the tall Grades dashboard panel) the courses are laid out
    // as TWO masonry columns of blocks, each block being the grade summary card
    // plus that course's recent graded submissions peeking out underneath it. The
    // toggle expands that list. Without opts the cards stay in a plain 2-up grid,
    // which is what the single-tab Grades view renders.
    const byCourse = withRecent ? recentByCourse(hiddenCourses) : new Map();
    if (courseCardsData.length > 0) {
      const stack = document.createElement('div');
      let cols = null;
      if (withRecent) {
        cols = [document.createElement('div'), document.createElement('div')];
        cols.forEach((c) => { c.className = 'course-grades-col'; stack.appendChild(c); });
        stack.className = 'course-grades-cols';
      } else {
        stack.className = 'course-grades-grid';
      }
      // Split the (already sorted) course list in half: the first half fills the
      // left column, the rest the right. Splitting rather than round-robining
      // means an expanded course grows only its own column — the row-mate beside
      // it keeps its natural height — and it also keeps the reading order correct
      // if the columns ever wrap to one per row on a narrow panel.
      const splitAt = withRecent ? Math.ceil(courseCardsData.length / 2) : 0;
      let seen = 0;
      courseCardsData.forEach(item => {
        seen += 1;
        const tier = gradeTierClass(item.pct);
        const isActiveFilter = state.activeCourseFilter === item.courseKey;
        const cCard = document.createElement('div');
        cCard.className = `course-grade-summary-card ${tier} ${isActiveFilter ? 'is-filtering' : ''}`;
        cCard.title = isActiveFilter ? 'Click to clear filter' : `Click to filter by ${item.courseKey}`;

        const coursePalette = getCourseColors(item.courseKey);
        cCard.style.setProperty('--course-accent', coursePalette.accent);
        cCard.style.setProperty('--course-glow', coursePalette.glow);
        cCard.style.setProperty('--course-soft', coursePalette.soft);

        // Syllabus grade breakdown for this course — a proportional bar plus one
        // line of labels, so each component's weight is visible at a glance.
        const proj = computeCourseProjection(item.courseKey);
        // Multi-distribution syllabi ("Distribution 1: ... / Distribution 2:
        // ...") get a mini select — picking one swaps which breakdown feeds the
        // what-if math and persists for later scans.
        const courseRes = (state.cachedCourseMap[item.courseKey] || {}).resources || {};
        const weightOptions = Array.isArray(courseRes.gradeWeightOptions) && courseRes.gradeWeightOptions.length > 1
        ? courseRes.gradeWeightOptions : null;
        const choiceIdx = weightOptions && typeof courseRes.gradeWeightChoice === 'number'
        ? Math.min(courseRes.gradeWeightChoice, weightOptions.length - 1) : 0;
        // The picker is pinned to the head's bottom-right corner by CSS rather than
// sitting in the content flow. Inline it read as a third fact about the course
// ("Distribution 1: Exam" is not information, it is a control), and as a stacked
// row it also cost the tile ~22px, which was the last thing making one course's
// tile taller than its neighbour's. The <select> is the real control — the chip
// behind it is decoration — so it stays keyboard- and screen-reader-navigable.
const pickerHtml = weightOptions
        ? `<span class="cg-corner-picker" title="${escapeHTML('Grading distribution: ' + (weightOptions[choiceIdx] || {}).label)}"><span class="cg-corner-picker-glyph" aria-hidden="true">⇄</span><select class="gci-weight-select" aria-label="Grading distribution for ${escapeHTML(item.courseKey)}">${weightOptions.map((o, i) => `<option value="${i}"${i === choiceIdx ? ' selected' : ''}>${escapeHTML(o.label || ('Distribution ' + (i + 1)))}</option>`).join('')}</select></span>`
        : '';
        const weightsBar = proj && Array.isArray(proj.weights) && proj.weights.length > 0
        ? weightBarHtml(proj.weights, coursePalette.accent)
        : '';
        // No .gci-weights-row wrapper: it was a column box whose only job was to
        // stack the picker over the bar, and stacking is exactly what cost the
        // tile its even height. The picker is out of flow now, pinned to a corner.
        const weightsRow = (weightsBar || pickerHtml)
        ? `<div class="cg-weights">${weightsBar}${pickerHtml}</div>`
        : '';

        // ONE card shape for every course, graded or not. The two branches
        // used to render different markup, which meant a course that gained
        // a grade mid-session (a scenario typed into the simulator) could
        // not be updated in place — the markup had to be swapped. One shape
        // means every number below is just a textContent write.
        const barPct = item.hasGrade ? Math.max(0, Math.min(100, item.pct)) : 0;
        const courseName = String((state.cachedCourseMap[item.courseKey] || {}).name || '').trim();
        const nameLine = courseName
          ? `<div class="cg-course-name" title="${escapeHTML(courseName)}">${escapeHTML(courseName)}</div>`
          : '';
        cCard.innerHTML = `
        <div class="cg-top-row">
        <span class="cg-name">${escapeHTML(item.courseKey)}</span>
        <div class="cg-score-wrap">
        <span class="cg-percent${item.hasGrade ? '' : ' no-grade'}">${item.hasGrade ? `${item.pct.toFixed(1)}%` : 'No grades yet'}</span>
        <span class="cg-letter"${item.hasGrade ? '' : ' style="display:none"'}>${escapeHTML(item.letter)}</span>
        </div>
        </div>
        ${nameLine}
        <div class="cg-bar-bg"><div class="cg-bar-fill" style="width:${barPct}%"></div></div>
        <div class="cg-need-line"></div>
        ${weightsRow}
        `;

        // The moving parts of this card, kept for the live what-if update.
        courseCardRefs.set(item.courseKey, {
          card: cCard,
          filtering: isActiveFilter,
          percent: cCard.querySelector('.cg-percent'),
          letter: cCard.querySelector('.cg-letter'),
          barFill: cCard.querySelector('.cg-bar-fill'),
          needLine: cCard.querySelector('.cg-need-line'),
        });
        applyCourseCardNumbers(courseCardRefs.get(item.courseKey), item.courseKey, item.pct);

        cCard.addEventListener('click', () => {
          applyCourseFilter(item.courseKey);
        });

        // Distribution picker (multi-distribution syllabi). Stop the card's
        // click-to-filter handler from firing when the select is used, then
        // swap the active weights and re-render so the what-if math updates.
        const gwSelect = cCard.querySelector('.gci-weight-select');
        if (gwSelect) {
          gwSelect.addEventListener('click', ev => ev.stopPropagation());
          gwSelect.addEventListener('change', () => {
            if (applyGradeWeightChoice(item.courseKey, parseInt(gwSelect.value, 10))) {
              rerender();
            }
          });
        }

        if (!withRecent) {
          stack.appendChild(cCard);
          return;
        }

        // One tile per course: the grade summary card, then that course's most
        // recent graded submissions peeking out directly beneath it, all inside a
        // single glass surface. The peek is visible with no interaction at all —
        // the toggle below it only reveals the rest of the history.
        const block = document.createElement('div');
        block.className = 'course-grade-block';
        // The tile is the surface and the card is a transparent region inside it,
        // so the filter ring has to be mirrored onto the block too.
        if (isActiveFilter) block.classList.add('is-filtering');
        // Repeat the course palette on the BLOCK as well as the card: the toggle
        // and list are siblings of the card, not children, so they would
        // otherwise inherit nothing and fall back to the grey in view-grades.css.
        block.style.setProperty('--course-accent', coursePalette.accent);
        block.style.setProperty('--course-glow', coursePalette.glow);
        block.appendChild(cCard);

        const mine = byCourse.get(item.courseKey) || [];
        const open = expandedCourses.has(item.courseKey);
        if (open) block.classList.add('is-recent-open');

        // The list area is rendered even for a course with nothing graded, so the
        // tile below always has the same three slots to fill. Without this a
        // zero-grade course collapsed to a stub and left its neighbour's tile
        // hanging 90px past the bottom of the pair.
        const col = document.createElement('div');
        col.className = 'course-recent-col';
        const shown = mine.slice(0, RECENT_PER_COURSE);
        // hideCourse: the card directly above already says which class these
        // belong to, so repeating the course tag on every row is pure noise.
        // compact: one line per row — in a 200px column a two-line card with a
        // letter badge and "81 out of 100" left no room for the title.
        // is-beyond-peek: rows past the resting peek, hidden by CSS until the
        // block is opened. Marking them in JS keeps RECENT_PEEK the single
        // source of truth instead of hard-coding an nth-child in the stylesheet.
        shown.forEach((g, i) => {
          const row = createGradeCard(g, { hideCourse: true, compact: true });
          if (i >= RECENT_PEEK) row.classList.add('is-beyond-peek');
          col.appendChild(row);
        });
        if (mine.length > shown.length) {
          const more = document.createElement('div');
          more.className = 'course-recent-more';
          more.textContent = `+${mine.length - shown.length} older`;
          col.appendChild(more);
        }
        block.appendChild(col);

        // A course whose whole history already fits inside the peek has nothing
        // to reveal, so it gets a quiet static label instead of a "Show all"
        // button that could only ever do nothing. Either way the footer row is
        // rendered: a missing footer is what made one course's tile a row
        // shorter than the one sitting beside it.
        if (mine.length > RECENT_PEEK) {
          // The toggle sits below the list rather than acting as its header,
          // now that the list is visible before it is ever touched.
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'course-recent-toggle';
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          toggle.innerHTML = `<span class="course-recent-chevron">${open ? '▾' : '▸'}</span>`
            + `<span class="course-recent-toggle-label">${open ? 'Show less' : 'Show all'}</span>`
            + `<span class="course-recent-count">${mine.length}</span>`;
          toggle.addEventListener('click', (ev) => {
            ev.stopPropagation();
            flipRecentColumn(item.courseKey, block, toggle);
          });
          block.appendChild(toggle);
        } else {
          // The reserved row still has to exist, but "All 0 shown" on a course
          // whose own card already says "No grades yet" is saying it twice.
          const foot = document.createElement('div');
          foot.className = 'course-recent-foot';
          if (mine.length) foot.textContent = `All ${mine.length} shown`;
          block.appendChild(foot);
        }
        (seen <= splitAt ? cols[0] : cols[1]).appendChild(block);
      });
      // A single course leaves the second column empty — drop it rather than
      // reserving half the panel for nothing.
      if (withRecent && !cols[1].children.length) cols[1].remove();
      listContainer.appendChild(stack);
    }

    // ---- Live grade refresh -------------------------------------------------
    // Recompute every course percentage from the current what-if scenarios and
    // push the result into the GPA card and the course summary cards, in
    // place. This is what lets a scenario update the whole panel live: no
    // re-render, so the caret stays where the student put it.
    function refreshGradeNumbers() {
      const pcts = computeCoursePercentagesWithWhatIf(hiddenCourses);
      const points = [];
      Object.entries(pcts).forEach(([, pct]) => {
        if (pct !== null && !isNaN(pct)) points.push(percentageToGpa(pct).gpa);
      });
      const avg = points.length > 0
        ? (points.reduce((a, b) => a + b, 0) / points.length).toFixed(2)
        : '—';
      const tier = points.length > 0 ? gradeTierClass((parseFloat(avg) / 4) * 100) : 'tier-none';
      const ringPct = points.length > 0 ? Math.max(0, Math.min(100, (parseFloat(avg) / 4) * 100)) : 0;

      gpaRefs.card.className = `gpa-card ${tier}`;
      gpaRefs.ring.style.setProperty('--gpa-pct', ringPct);
      gpaRefs.value.textContent = avg;
      gpaRefs.sub.textContent = points.length > 0
        ? `Based on ${points.length} graded course${points.length === 1 ? '' : 's'}`
        : 'No grades posted yet';
      gpaRefs.flag.style.display = Object.keys(state.whatIfScores).length > 0 ? '' : 'none';

      courseCardRefs.forEach((refs, cKey) => {
        const pct = pcts[cKey];
        const has = pct !== null && pct !== undefined && !isNaN(pct);
        // The tier colour travels with the percentage, so a scenario that
        // lifts a course from a C to a B recolours the card too.
        refs.card.className = `course-grade-summary-card ${has ? gradeTierClass(pct) : 'tier-none'} ${refs.filtering ? 'is-filtering' : ''}`;
        applyCourseCardNumbers(refs, cKey, pct);
      });
    }

    // ---- Grade Simulator ----------------------------------------------------
    // The simulator sits at the bottom of the panel: it is a tool you reach
    // for, not a summary you read. It renders once and then updates itself
    // in place, so typing a score never rebuilds the panel around it.
    const simulatorCourses = Object.keys(state.cachedCourseMap).filter(cKey => {
      if (hiddenCourses.includes(cKey)) return false;
      if (state.activeCourseFilter !== 'ALL' && state.activeCourseFilter !== cKey) return false;
      const course = state.cachedCourseMap[cKey];
      return ((course && course.tasks) || []).some(t => t.points && t.points > 0);
    });
    // Scenarios left over from earlier still deserve a way in, even if
    // everything they pointed at has since been graded.
    const hasScenarios = Object.keys(state.whatIfScores).length > 0;

    if (simulatorCourses.length > 0 || hasScenarios) {
      const simulator = createGradeSimulator({
        hiddenCourses,
        onChange: refreshGradeNumbers,
      });
      listContainer.appendChild(simulator.element);
    }

    // Fill the GPA card in now that every course card exists. The same
    // function is what the simulator calls after each scenario change.
    refreshGradeNumbers();

    // The per-submission "Recent Feedback" list now lives only in the
    // bottom-left Recent Grades dashboard panel, so this right-hand Grades
    // panel keeps just the GPA ring, the course summaries and the simulator.
  }

// opts.hideCourse suppresses the course tag: used when the card is rendered
// inside a per-course column whose header already names the class.
export function createGradeCard(grade, opts) {
    const card = document.createElement('div');
    // compact: the one-line rows inside a course's recent-grade peek. In a 200px
    // column the letter badge and the "81 out of 100" text were both redundant
    // next to the percentage chip and squeezed the title down to a few
    // characters; the exact score survives in the row's tooltip.
    const compact = !!(opts && opts.compact);

    const hasPoints = grade.pointsPossible !== null && grade.pointsPossible !== undefined && !isNaN(grade.pointsPossible);
    const pct = hasPoints && grade.pointsPossible > 0 ? (grade.score / grade.pointsPossible) * 100 : null;
    const tier = gradeTierClass(pct);
    card.className = `grade-card ${tier}`;

    const coursePalette = getCourseColors(grade.courseKey);
    card.style.setProperty('--course-accent', coursePalette.accent);
    card.style.setProperty('--course-glow', coursePalette.glow);
    card.style.setProperty('--course-soft', coursePalette.soft);
    const scoreLabel = hasPoints
    ? `${formatScoreNum(grade.score)} out of ${formatScoreNum(grade.pointsPossible)}`
    : `${formatScoreNum(grade.score)} pts`;

    const gradedLabel = grade.gradedAt
    ? grade.gradedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';

    const titleEl = document.createElement(grade.url ? 'a' : 'div');
    titleEl.className = 'grade-title';
    titleEl.innerText = grade.title;
    if (grade.url) {
      titleEl.href = grade.url;
      titleEl.target = '_blank';
      titleEl.rel = 'noopener noreferrer';
      // Canvas grade rows open the in-app YACE assignment viewer instead of a
      // new tab (plain href kept for middle-click).
      const urlMatch = grade.url.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
      if (urlMatch && grade.canvasAssignmentId) {
        titleEl.addEventListener('click', (e) => {
          e.preventDefault();
          openCanvasViewer({
            kind: 'assignment',
            courseId: urlMatch[1],
            assignmentId: grade.canvasAssignmentId,
            courseKey: grade.courseKey,
            courseName: grade.courseName,
            title: grade.title,
            url: grade.url
          });
        });
      }
    }

    const courseSpan = document.createElement('span');
    courseSpan.className = 'grade-course';
    courseSpan.innerText = grade.courseName;

    const meta = document.createElement('div');
    meta.className = 'grade-meta';
    if (!(opts && opts.hideCourse)) meta.appendChild(courseSpan);

    if (grade.isGradescope) {
      const gsTag = document.createElement('span');
      gsTag.className = 'badge-tag gs-source';
      gsTag.innerText = 'Gradescope';
      meta.appendChild(gsTag);
    }

    if (gradedLabel) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'grade-date';
      dateSpan.innerText = gradedLabel;
      meta.appendChild(dateSpan);
    }

    const scoreDiv = document.createElement('div');
    scoreDiv.className = 'grade-score' + (compact ? ' is-compact' : '');
    scoreDiv.title = scoreLabel;
    if (!compact) scoreDiv.innerText = scoreLabel;
    if (pct !== null) {
      const pctChip = document.createElement('span');
      pctChip.className = 'grade-score-pct';
      pctChip.innerText = `${pct.toFixed(1)}%`;
      scoreDiv.appendChild(pctChip);
    }

    const check = document.createElement('span');
    check.className = 'grade-check';
    check.innerText = pct !== null ? percentageToGpa(pct).letter : '✓';

    const body = document.createElement('div');
    body.className = 'grade-body';
    body.appendChild(titleEl);
    body.appendChild(meta);
    body.appendChild(scoreDiv);

    // Skipped in compact mode: the percentage chip already carries the tier, in
    // the tier's own colour.
    if (!compact) card.appendChild(check);
    card.appendChild(body);

    return card;
  }
