// Rate My Professor tab inside the Campus & Tools drawer (the same overlay
// that hosts Food + WebCat Reg). The RMP panels used to live inside each
// Info-tab course card; they now get a dedicated, roomier surface here so
// the Info panel can focus on course links/syllabus/office-hours/weights.
//
// Everything below the header note is the original per-course panel logic
// moved verbatim from general-view.js: instructor names come from parsed
// syllabi, ratings from the RMP GraphQL API via background.js, and the
// extension is UNH-scoped (RMP legacyId 1231).

import { state } from '../state.js';
import { escapeHTML } from '../utils/text.js';
import { fetchProfessorReviews, peekBestTeacher, peekProfessorReviews, professorProfileUrl, RMP_SCHOOL_PAGE_URL, resolveBestTeacher } from '../services/rmp-api.js';

function rmpScoreClass(value) {
  if (value == null) return '';
  return value >= 4 ? 'is-good' : value >= 3 ? 'is-mid' : 'is-bad';
}

function rmpLoadingHtml(professorName) {
  return `
    <div class="rmp-loading">
      <span class="rmp-loading-tile"></span>
      <span class="rmp-loading-lines">
        <span class="rmp-loading-line" style="width: 62%"></span>
        <span class="rmp-loading-line" style="width: 88%"></span>
        <span class="rmp-loading-line" style="width: 42%"></span>
      </span>
    </div>
    <p class="rmp-panel-note">Looking up ${escapeHTML(professorName)} on Rate My Professor…</p>`;
}

function rmpRatedHtml(teacher) {
  const rating = teacher.avgRatingRounded != null ? teacher.avgRatingRounded.toFixed(1) : null;
  const difficulty = teacher.avgDifficultyRounded != null ? teacher.avgDifficultyRounded.toFixed(1) : null;
  const scoreValue = rating ? parseFloat(rating) : null;
  const wouldAgain = (teacher.wouldTakeAgainPercentRounded != null && teacher.wouldTakeAgainPercentRounded >= 0)
    ? `${Math.round(teacher.wouldTakeAgainPercentRounded)}%` : null;
  const name = `${teacher.firstName} ${teacher.lastName}`;
  const nameHtml = escapeHTML(name);
  const meta = [
    teacher.department ? escapeHTML(teacher.department) : null,
    teacher.numRatings ? `${teacher.numRatings} rating${teacher.numRatings === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const tags = (Array.isArray(teacher.teacherRatingTags) ? teacher.teacherRatingTags : [])
    .filter(t => t && t.tagName)
    .slice(0, 4)
    .map(t => `<span class="rmp-tag">${escapeHTML(t.tagName)}</span>`)
    .join('');
  const profileUrl = professorProfileUrl(teacher);
  // "Comments" is a disclosure, not a fetch: the panel below it stays empty
  // until this button is pressed (see toggleReviews). That keeps opening the
  // Ratings tab at exactly one small request per instructor instead of pulling
  // tens of KB of review text for every course at once.
  const cachedReviews = teacher.numRatings > 0 ? peekProfessorReviews(teacher) : null;
  return `
    <div class="rmp-head">
      <span class="rmp-score-big ${scoreValue != null ? rmpScoreClass(scoreValue) : 'is-none'}">${rating || '—'}</span>
      <span class="rmp-prof">
        <span class="rmp-prof-name" title="${nameHtml}">${nameHtml}</span>
        <span class="rmp-prof-meta">${meta || 'University of New Hampshire'}</span>
      </span>
    </div>
    <div class="rmp-line">
      <span class="rmp-line-label">Difficulty</span>
      <span class="rmp-bar"><span class="rmp-bar-fill" style="width: ${difficulty ? Math.max(0, Math.min(100, parseFloat(difficulty) * 20)) : 0}%"></span></span>
      <span class="rmp-line-value">${difficulty ? `${difficulty}/5` : '—'}</span>
    </div>
    ${wouldAgain ? `<div class="rmp-line"><span class="rmp-line-label">Would take again</span><span class="rmp-line-value">${wouldAgain}</span></div>` : ''}
    ${tags ? `<div class="rmp-tags">${tags}</div>` : ''}
    <div class="rmp-links">
      <button type="button" class="rmp-link rmp-reviews-toggle" aria-expanded="false">💬 What students say${cachedReviews && cachedReviews.reviews.length ? ` (${cachedReviews.reviews.length}${cachedReviews.hasNextPage ? '+' : ''})` : ''}</button>
      ${profileUrl ? `<a class="rmp-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer">Open profile ↗</a>` : ''}
      <a class="rmp-link" href="${RMP_SCHOOL_PAGE_URL}" target="_blank" rel="noopener noreferrer">UNH on RMP</a>
    </div>
    <div class="rmp-reviews" hidden></div>`;
}

function rmpMissingHtml(name, zeroRatings) {
  const nameHtml = escapeHTML(name);
  return `
    <div class="rmp-head rmp-head-missing">
      <span class="rmp-score-big is-none">?</span>
      <span class="rmp-prof">
        <span class="rmp-prof-name" title="${nameHtml}">${nameHtml}</span>
        <span class="rmp-prof-meta">${zeroRatings ? 'No ratings yet at UNH' : 'No rate-my-professor page found'}</span>
      </span>
    </div>
    <p class="rmp-panel-note">${zeroRatings
      ? 'This instructor has no ratings on Rate My Professor yet. Check back, or browse the UNH school page.'
      : "Couldn't locate this instructor on Rate My Professor. Browse the UNH school page instead."}</p>
    <div class="rmp-links">
      <a class="rmp-link" href="${RMP_SCHOOL_PAGE_URL}" target="_blank" rel="noopener noreferrer">UNH on RMP ↗</a>
    </div>`;
}

function buildRmpPanelHtml(professorName, teacher, status) {
  const title = `<div class="rmp-panel-header"><span class="rmp-panel-title">🎓 Rate My Professor</span><span class="rmp-panel-badge">UNH</span></div>`;
  let body;
  if (status === 'loading') body = rmpLoadingHtml(professorName || '…');
  else if (teacher && teacher.firstName && teacher.lastName) {
    body = teacher.numRatings > 0
      ? rmpRatedHtml(teacher)
      : rmpMissingHtml(`${teacher.firstName} ${teacher.lastName}`, true);
  } else {
    body = rmpMissingHtml(professorName || 'No instructor found', false);
  }
  return title + body;
}

/* ---------------------------------------------------------------------------
 * "What students say" — review cards, fetched only on click
 * ------------------------------------------------------------------------- */

// "2024-10-12T02:00:34 +0000 UTC" -> "Oct 2024". Reviews are only worth showing
// with a rough date attached; a malformed one degrades to no date at all rather
// than "Invalid Date".
function reviewDateLabel(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function reviewCardHtml(review) {
  const date = reviewDateLabel(review.date);
  const bits = [];
  if (review.quality != null) bits.push(`<span class="rmp-review-chip is-score ${rmpScoreClass(review.quality)}">${review.quality}/5</span>`);
  if (review.difficulty != null) bits.push(`<span class="rmp-review-chip">difficulty ${review.difficulty}/5</span>`);
  if (review.grade) bits.push(`<span class="rmp-review-chip">grade ${escapeHTML(review.grade)}</span>`);
  if (date) bits.push(`<span class="rmp-review-chip">${escapeHTML(date)}</span>`);
  // review.comment is arbitrary student text: escapeHTML is load-bearing here.
  return `
    <div class="rmp-review">
      <div class="rmp-review-chips">${bits.join('')}</div>
      ${review.tags.length ? `<div class="rmp-review-tags">${review.tags.map(t => `<span class="rmp-tag">${escapeHTML(t)}</span>`).join('')}</div>` : ''}
      <p class="rmp-review-body">${escapeHTML(review.comment)}</p>
    </div>`;
}

function reviewsListHtml(reviews, hasNextPage) {
  if (!reviews.length) {
    return '<div class="rmp-reviews-empty">No written reviews on Rate My Professor for this instructor yet.</div>';
  }
  return reviews.map(reviewCardHtml).join('')
    + (hasNextPage ? '<button type="button" class="rmp-reviews-more">Load more comments</button>' : '');
}

function renderReviewsPanel(box, teacher) {
  const cached = peekProfessorReviews(teacher);
  if (!cached || !cached.reviews.length) {
    box.innerHTML = '<div class="rmp-reviews-loading">Loading comments…</div>';
    return;
  }
  box.innerHTML = reviewsListHtml(cached.reviews, cached.hasNextPage);
  wireReviewsPanel(box, teacher);
}

// Wires "Load more" against the cached cursor. The panel is rebuilt from the
// cache after every page so there's a single source of truth for what's shown —
// appending raw nodes instead would let the cached list and the DOM drift.
function wireReviewsPanel(box, teacher) {
  const more = box.querySelector('.rmp-reviews-more');
  if (!more) return;
  more.addEventListener('click', async () => {
    const cached = peekProfessorReviews(teacher);
    const cursor = (cached && cached.cursor) || null;
    if (!cursor) return;
    more.disabled = true;
    more.textContent = 'Loading…';
    const page = await fetchProfessorReviews(teacher, { after: cursor });
    if (!page) {
      // Rate-limited or offline. The retry window in rmp-api means the next
      // click will be served the same way, so say what happened rather than
      // leaving a dead button.
      more.textContent = "Couldn't load more — try again in a moment";
      more.disabled = false;
      return;
    }
    renderReviewsPanel(box, teacher);
  });
}

// Toggles the disclosure. Everything expensive is inside the `if (!open)` branch
// so collapsing and re-expanding is free and never re-fetches.
async function toggleReviews(toggle, teacher) {
  // closest() rather than walking parentElement twice: the toggle lives inside
  // .rmp-links inside .rmp-panel, and that depth is a markup detail that has
  // no reason to be load-bearing.
  const box = toggle.closest('.rmp-panel') && toggle.closest('.rmp-panel').querySelector('.rmp-reviews');
  if (!box) return;
  const open = toggle.getAttribute('aria-expanded') === 'true';

  if (open) {
    box.hidden = true;
    box.innerHTML = '';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }

  box.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  renderReviewsPanel(box, teacher);

  // Only reach the network if the cache couldn't satisfy the panel.
  if (peekProfessorReviews(teacher)) return;
  const page = await fetchProfessorReviews(teacher);
  if (!page) {
    box.innerHTML = '<div class="rmp-reviews-empty">Couldn\u2019t load comments from Rate My Professor right now.</div>';
    return;
  }
  renderReviewsPanel(box, teacher);
}

// Re-attaches the panel's listeners after its markup is (re)written. Call
// whenever panel.innerHTML is replaced.
//
// The matched teacher is stashed as a JS property on the node rather than
// serialized into an attribute: it's a whole GraphQL object with nested school
// and tag arrays, and campus-tools-modal keeps these nodes alive for the
// session, so the reference survives tab switches. (Caching innerHTML strings
// would have dropped both the property and the listeners.)
function wirePanelInteractions(panel, teacher) {
  if (!panel) return;
  if (teacher) panel.__rmpTeacher = teacher;
  const resolved = panel.__rmpTeacher;
  const toggle = panel.querySelector('.rmp-reviews-toggle');
  if (!toggle || !resolved) return;
  toggle.addEventListener('click', () => toggleReviews(toggle, resolved));
}

async function loadRmpPanel(panel) {
  if (!panel) return;
  // The attribute carries a JSON array, NOT a comma-joined string. Canvas
  // sortable names contain a comma ("Mahmud, Shaad"), so a split(',') transport
  // tore every professor into a last name and a first name — the lookup then
  // matched neither, and the card's heading showed only the surname. JSON is
  // the only separator that can't occur inside a name; the bare-string branch
  // is a fallback for panels written by older markup.
  let instructors;
  try {
    const parsed = JSON.parse(panel.getAttribute('data-instructors') || '[]');
    instructors = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    instructors = (panel.getAttribute('data-instructors') || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  instructors = instructors.map(s => String(s).trim()).filter(Boolean);
  if (!instructors.length) return;
  const primary = instructors[0];
  for (const name of instructors) {
    const teacher = await resolveBestTeacher(name);
    if (teacher) {
      panel.innerHTML = buildRmpPanelHtml(primary, teacher, 'ok');
      wirePanelInteractions(panel, teacher);
      return;
    }
  }
  panel.innerHTML = buildRmpPanelHtml(primary, null, 'none');
}

// Lists every visible course with at least one parsed instructor, one RMP
// panel per course (same data-instructors fallback chain as the old Info
// cards), newest cache hits render instantly and misses resolve async.
export function renderRmpView(listContainer, hiddenCourses) {
  listContainer.innerHTML = '';

  const courses = Object.entries(state.cachedCourseMap)
    .filter(([key, c]) => !hiddenCourses.includes(key) && c && c.canvasCourseId)
    .map(([key, c]) => ({
      key: key,
      name: c.name || key,
      professors: (c.resources && Array.isArray(c.resources.professors)) ? c.resources.professors : [],
    }))
    .filter(c => c.professors.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Scroll region — the shared .campus-tools-body must stay overflow:visible
  // for the dining plate/pie overlays, so the RMP list scrolls in its own
  // flexed container instead.
  const scroll = document.createElement('div');
  scroll.className = 'rmp-tab-scroll';
  listContainer.appendChild(scroll);

  if (courses.length === 0) {
    scroll.innerHTML = '<div class="mod-empty-msg">No professors found this term.</div>';
    return;
  }

  const header = document.createElement('div');
  header.className = 'rmp-view-header';
  header.innerHTML = `
    <div class="rmp-panel-header"><span class="rmp-panel-title">🎓 Rate My Professor</span><span class="rmp-panel-badge">UNH</span></div>
    <p class="rmp-view-note">Ratings for your ${courses.length} course${courses.length === 1 ? '' : 's'} · instructor names parsed from Canvas syllabi.</p>
  `;
  scroll.appendChild(header);

  courses.forEach(({ key, professors }) => {
    const primary = professors[0] || '';
    const cached = primary ? peekBestTeacher(primary) : null;
    const status = cached ? 'ok' : (primary ? 'loading' : 'none');

    const block = document.createElement('div');
    block.className = 'rmp-course-block';
    block.innerHTML = `
    <div class="rmp-course-tag">${escapeHTML(key)}</div>
    <div class="rmp-panel" data-course-key="${escapeHTML(key)}" data-instructors="${escapeHTML(JSON.stringify(professors))}">
    ${buildRmpPanelHtml(primary, cached, status)}
    </div>
    `;
    scroll.appendChild(block);

    const panel = block.querySelector('.rmp-panel');
    if (cached) {
      // Cache hit — the card is already final, so its "What students say"
      // button can be wired immediately with no lookup at all.
      wirePanelInteractions(panel, cached);
    } else if (primary) {
      loadRmpPanel(panel);
    }
  });
}