// Rates our professors (Rate My Professor) lookups for the Info tab.
//
// The actual GraphQL request runs in background.js (FETCH_RMP message) — the
// dashboard content script can't CORS-fetch ratemyprofessors.com, and the
// background page owns the request headers. This module handles name
// matching, in-memory de-duping of in-flight calls, and a localStorage cache
// (24h TTL, keyed by normalized instructor name) so the 30s view re-render
// doesn't hammer RMP.

import { STORAGE_KEY_RMP_CACHE, STORAGE_KEY_RMP_REVIEWS } from '../constants.js';

const RMP_CACHE_TTL = 24 * 60 * 60 * 1000;

// Extension is UNH-scoped: RMP lookups always target the "University of New
// Hampshire (all campuses)" school (RMP legacyId 1231), and the school page
// is the natural landing spot when a professor can't be matched.
export const RMP_SCHOOL_PAGE_URL = 'https://www.ratemyprofessors.com/school/1231';

// Name -> Promise<Teacher|null> for calls in flight right now.
const pending = new Map();

// In-memory short-TTL memo of negative lookups (no match found) so a failed
// multi-variant search doesn't re-hit RMP on every 30s re-render. Ephemeral —
// cleared on page reload; the persisted cache only stores fetched lists.
const negativeCache = new Map();
const NEGATIVE_CACHE_TTL = 5 * 60 * 1000;

function isNegativeCached(key) {
  const at = negativeCache.get(key);
  return at != null && Date.now() - at < NEGATIVE_CACHE_TTL;
}

// Titles/degrees that prefix a Canvas display name ("MD Shaad Mahmud") and
// throw off both RMP search and token matching. Stripped before searching and
// filtered out of match tokens.
const NAME_TITLE_RE = /^(?:professor|prof|dr|doctor|instructor|lecturer|adjunct|assistant|associate|clinical|emeritus|dean|chair|president|mr|mrs|ms|miss|md|phd|dds|dvm|jd|esq|mfa|mba|ma|ba|bs|bsc)\b\.?\s*/i;

function cleanNameForSearch(name) {
  let n = String(name || '');
  // Drop asides: (he/him), (PhD), etc.
  n = n.replace(/\([^)]*\)/g, ' ');
  // Strip leading titles / degrees ("Dr. John Smith" / "MD Shaad Mahmud" ->
  // "John Smith" / "Shaad Mahmud") so RMP search sees a plain name.
  n = n.replace(NAME_TITLE_RE, '');
  // "Last, First M." -> "First M. Last" so RMP sees normal word order.
  const commaFlip = n.match(/^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){0,2})\s*,\s+([a-zA-Z][a-zA-Z' .-]*)$/);
  if (commaFlip) n = `${commaFlip[2].trim()} ${commaFlip[1]}`.replace(/\s{2,}/g, ' ').trim();
  n = n.replace(/\s{2,}/g, ' ').trim();
  return n;
}

// Query variants probed in order; the strongest early match wins and the
// merged result list is cached so later re-renders pick from the union.
function searchVariants(name) {
  const raw = String(name || '');
  const variants = [];
  const seen = new Set();
  const add = (text) => {
    const v = String(text || '').replace(/\s+/g, ' ').trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    variants.push(v);
  };
  add(cleanNameForSearch(raw));        // title-stripped, comma-flipped
  add(raw.replace(NAME_TITLE_RE, '')); // title-stripped only
  add(raw);                            // raw as-is
  return variants;
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RMP_CACHE) || '{}');
  } catch (e) {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(STORAGE_KEY_RMP_CACHE, JSON.stringify(cache));
  } catch (e) {
    // Quota / private-mode write failures shouldn't break the view.
  }
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m > n) return levenshtein(b, a);
  let prev = [...Array(m + 1).keys()];
  for (let j = 1; j <= n; j++) {
    const cur = [j];
    for (let i = 1; i <= m; i++) {
      cur[i] = Math.min(
        prev[i] + 1,
        cur[i - 1] + 1,
        prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[m];
}

// First-name agreement for fuzzy matching: exact, a close typo/variant (edit
// distance <= 1, e.g. "Kevan"~"Kevin"), a shared >= 2-char prefix ("Mike"~
// "Michael"), or an initial vs. full name ("J."~"John"). "Mark" vs "Michael"
// (only the same initial) no longer passes.
function firstNamesClose(a, b) {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  if (levenshtein(a, b) <= 1) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 2;
}

// Lowercases a name into a title-stripped token list for fuzzy comparison.
function cleanNameForMatch(name) {
  let n = String(name || '');
  // "Last, First" -> "First Last" (Canvas sortable names arrive this way).
  const commaFlip = n.match(/^([a-zA-Z'.-]+(?:\s+[a-zA-Z'.-]+){0,2})\s*,\s+([a-zA-Z][a-zA-Z' .-]*)$/);
  if (commaFlip) n = `${commaFlip[2].trim()} ${commaFlip[1]}`.replace(/\s{2,}/g, ' ').trim();
  return n
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s'.-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^['.\-]+|['.\-]+$/g, '').trim())
    .filter(Boolean)
    .filter(t => !NAME_TITLE_RE.test(t));
}

// Best guess when the syllabus/enrollment name doesn't exactly match RMP's
// listing. Surname is the anchor; first-name agreement bumps the score;
// middle names/initials on either side are ignored; and every meaningful
// target token being present in the candidate covers titles like "MD" that
// slip through. Scores map to: 100 exact, 85 first+last match w/ middle
// slack, 60 same surname + close first name, 55 containment.
function nameMatchScore(target, cand) {
  const tl = target.length;
  const cl = cand.length;
  if (!tl || !cl) return 0;

  const targetLast = target[tl - 1];
  const candLast = cand[cl - 1];

  // Exact sequence match: "shaad mahmud" === "shaad mahmud".
  if (tl === cl && target.every((t, i) => t === cand[i])) return 100;

  const candSet = new Set(cand);
  const meaningful = target.filter(t => t.length > 1);

  if (targetLast !== candLast) {
    // Surname mismatch is only OK if every meaningful target token is
    // embedded in the candidate (e.g. "Md Shaad Mahmud" vs "Shaad Mahmud"
    // when titles weren't stripped) — and containment alone stays below the
    // acceptance bar, so this only helps score comparisons.
    if (meaningful.length && meaningful.every(t => candSet.has(t))) return 55;
    return 0;
  }

  const targetFirst = target[0];
  const candFirst = cand[0];
  let score = 40; // surname match alone
  if (targetFirst === candFirst) score = 80;
  else if (firstNamesClose(targetFirst, candFirst)) score = 60;
  else if (meaningful.length && meaningful.every(t => candSet.has(t))) score = 55;

  // Middle-name/initial slack: "John A. Smith" ↔ "John Smith" is a solid
  // match once first and last names agree.
  if (score >= 80) score = 85;

  return score;
}

// Picks the RMP teacher that best matches a syllabus/enrollment-extracted
// name. Returns null unless we're reasonably confident (>= 60: exact or full
// first+last agreement, same-surname + close first name (typo/variant/
// initials/prefix), or token containment with the rating tie-break).
export function pickBestTeacher(teachers, professorName) {
  const targetTokens = cleanNameForMatch(professorName);
  if (!targetTokens.length || !Array.isArray(teachers)) return null;

  let best = null;
  let bestScore = 0;
  teachers.forEach(t => {
    if (!t || !t.firstName || !t.lastName) return;
    const candTokens = cleanNameForMatch(`${t.firstName} ${t.lastName}`);
    if (!candTokens.length) return;
    let score = nameMatchScore(targetTokens, candTokens);
    // Prefer the rated teacher over a same-scoring 0-rating doppelgänger.
    if (score > 0 && t.numRatings > 0) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  });

  return bestScore >= 60 ? best : null;
}

export function professorProfileUrl(teacher) {
  return teacher && teacher.legacyId
    ? `https://www.ratemyprofessors.com/professor/${teacher.legacyId}`
    : null;
}

// Synchronous cache check — lets the Ratings tab paint known ratings on its
// first frame, before the async misses resolve. (The tab itself is rendered
// once per session and then kept alive by campus-tools-modal's toolHosts map,
// so this runs a handful of times per page load, not on the 30s poll.)
export function peekBestTeacher(professorName) {
  const key = normalizeName(professorName);
  if (!key) return null;
  const entry = readCache()[key];
  if (!entry || !Array.isArray(entry.teachers) || Date.now() - entry.fetchedAt > RMP_CACHE_TTL) {
    return null;
  }
  return pickBestTeacher(entry.teachers, professorName);
}

// Async lookup with cache + in-flight de-duplication. Resolves to a Teacher
// object or null (also null on network failure).
export async function resolveBestTeacher(professorName) {
  const key = normalizeName(professorName);
  if (!key) return null;
  if (isNegativeCached(key)) return null;

  const cached = peekBestTeacher(professorName);
  if (cached) return cached;
  if (pending.has(key)) return pending.get(key);

  const promise = (async () => {
    try {
      // RMP search is picky about "MD Shaad Mahmud"-style display names, so
      // probe a few query variants and keep the strongest match. If a strong
      // match surfaces early we stop probing; the merged result list is still
      // cached so later re-renders pick from the union.
      const variants = searchVariants(professorName);
      const allTeachers = [];
      const seenIds = new Set();
      let matched = null;
      for (const text of variants) {
        const resp = await browser.runtime.sendMessage({ type: 'FETCH_RMP', text });
        const batch = (resp && resp.success && Array.isArray(resp.teachers)) ? resp.teachers : [];
        batch.forEach(t => {
          if (!t) return;
          const id = t.legacyId != null ? t.legacyId : `${t.firstName}|${t.lastName}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            allTeachers.push(t);
          }
        });
        matched = pickBestTeacher(allTeachers, professorName);
        if (matched) break;
      }

      // Only a lookup that actually reached RMP and got an answer is worth
      // persisting. When EVERY variant failed (`allTeachers` empty) the lookup
      // tells us nothing — caching that as a 24h entry made peekBestTeacher
      // report a hit on an empty list, so the card rendered its "loading"
      // placeholder forever instead of its "not found" state. Leave the
      // negative cache to do the rate-limiting instead.
      if (allTeachers.length) {
        const cache = readCache();
        cache[key] = { fetchedAt: Date.now(), teachers: allTeachers };
        writeCache(cache);
      }

      if (!matched) negativeCache.set(key, Date.now());
      return matched;
    } catch (e) {
      console.warn('[RMP] lookup failed for', professorName, e);
      return null;
    }
  })();

  pending.set(key, promise);
  promise.finally(() => pending.delete(key)).catch(() => {});
  return promise;
}

/* ---------------------------------------------------------------------------
 * Written student reviews ("what students actually say")
 * ---------------------------------------------------------------------------
 *
 * Separate from the teacher lookup above on purpose:
 *
 *   - Different query. Reviews hang off the Teacher type's `ratings`
 *     connection and are reached through `node(id:)`, so they need the opaque
 *     GraphQL `id` rather than legacyId. RMP caps a page at a small number, so
 *     the rest is cursor paging.
 *   - Different volume. One lookup is a handful of summary fields; 20 reviews
 *     are tens of kilobytes of free-text. Nobody wants that fetched for all six
 *     of their courses when they open the tab, so reviews load ONLY when the
 *     reader presses "Comments" on a card. The Ratings tab itself stays one
 *     small request per instructor.
 *   - Different cache. Summaries go stale in a day; a student's write-up of a
 *     semester is effectively permanent, so reviews get a week.
 *
 * Everything else follows the same three-part contract as the rest of the
 * extension's fetches: in-flight dedup, a failure backoff, and a freshness
 * check — otherwise a review panel left open across a RMP hiccup turns into a
 * request loop.
 */

const RMP_REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const RMP_REVIEWS_PAGE = 5;

// Hard ceiling on how much review text we keep per professor. RMP comments run
// to ~4000 chars, so an uncapped "Load more" would quietly grow the localStorage
// blob toward the 5MB quota, at which point every other write in the extension
// starts failing.
const MAX_CACHED_REVIEWS = 20;

// In-flight review pages, keyed `nodeId::cursor`.
const pendingReviews = new Map();

// Failed review fetches, keyed the same way — a downed RMP must not be retried
// on every click of the Comments button.
const reviewsFailedAt = new Map();
const REVIEWS_RETRY_WINDOW_MS = 2 * 60 * 1000;

// RMP returns comment text as Latin1String, so bodies can carry stray control
// characters and lone high bytes. Strip anything that isn't printable text
// before it reaches innerHTML.
function sanitizeComment(raw) {
  return String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function readReviewsCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_RMP_REVIEWS) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Drop expired entries, then anything over quota, oldest-fetched first. Called
// before every write so the blob can't creep past the cap.
function pruneReviewsCache(cache) {
  const now = Date.now();
  let kept = {};
  Object.keys(cache).forEach(k => {
    const entry = cache[k];
    if (entry && now - (entry.fetchedAt || 0) < RMP_REVIEWS_TTL) kept[k] = entry;
  });
  const keys = Object.keys(kept).sort((a, b) => (kept[a].fetchedAt || 0) - (kept[b].fetchedAt || 0));
  while (keys.length > 24) delete kept[keys.shift()];
  return kept;
}

function writeReviewsCache(cache) {
  try {
    localStorage.setItem(STORAGE_KEY_RMP_REVIEWS, JSON.stringify(pruneReviewsCache(cache)));
  } catch (e) {
    // Quota / private mode. Reviews are a nice-to-have; never let this throw.
  }
}

// Everything already cached for this teacher, or null. The view calls this
// synchronously on click so the panel can paint instantly with no spinner for
// anything we've seen before.
export function peekProfessorReviews(teacher) {
  const id = teacher && teacher.legacyId;
  if (!id) return null;
  const entry = readReviewsCache()[`r${id}`];
  if (!entry || !Array.isArray(entry.reviews) || Date.now() - (entry.fetchedAt || 0) > RMP_REVIEWS_TTL) {
    return null;
  }
  return entry;
}

function normalizeReview(node) {
  if (!node) return null;
  const comment = sanitizeComment(node.comment);
  if (!comment) return null;
  return {
    id: node.id != null ? String(node.id) : null,
    date: node.date || null,
    comment,
    // qualityRating is the per-review 1-5 score (Rating has no `rating` field).
    quality: typeof node.qualityRating === 'number' ? node.qualityRating : null,
    difficulty: typeof node.difficultyRatingRounded === 'number' ? node.difficultyRatingRounded : null,
    grade: node.grade || null,
    courseType: typeof node.courseType === 'number' ? node.courseType : null,
    tags: String(node.ratingTags || '').split('--').map(s => s.trim()).filter(Boolean).slice(0, 5),
  };
}

/**
 * Load one page of reviews. `opts.after` is the cursor from a previous page;
 * omit it for the first page. Resolves to
 * { reviews, endCursor, hasNextPage } or null when the fetch failed.
 *
 * Callers should pass the result of peekProfessorReviews() so already-cached
 * pages never touch the network.
 */
export async function fetchProfessorReviews(teacher, opts) {
  const o = opts || {};
  const id = teacher && teacher.legacyId;
  const nodeId = teacher && teacher.id;
  if (!nodeId) return null;

  const after = o.after ? String(o.after) : '';
  const key = `${nodeId}::${after}`;

  if (!o.force) {
    const at = reviewsFailedAt.get(key);
    if (at != null && Date.now() - at < REVIEWS_RETRY_WINDOW_MS) return null;
    if (pendingReviews.has(key)) return pendingReviews.get(key);
  }

  const promise = (async () => {
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'FETCH_RMP_REVIEWS',
        nodeId,
        after: after || null,
        first: RMP_REVIEWS_PAGE,
      });
      if (!resp || !resp.success) {
        reviewsFailedAt.set(key, Date.now());
        return null;
      }
      reviewsFailedAt.delete(key);

      const page = (resp.reviews || []).map(normalizeReview).filter(Boolean);
      const payload = {
        reviews: page,
        endCursor: resp.endCursor || null,
        hasNextPage: !!resp.hasNextPage,
      };

      // Accumulate into the per-teacher cache entry so a reload can resume
      // paging without refetching, and cap the stored text.
      const cache = pruneReviewsCache(readReviewsCache());
      const entryKey = `r${id}`;
      const priorEntry = cache[entryKey];
      const prior = priorEntry && Array.isArray(priorEntry.reviews) ? priorEntry.reviews : [];
      const seen = new Set(prior.map(r => r && r.id).filter(Boolean));
      const merged = prior.concat(page.filter(r => !r.id || !seen.has(r.id)));
      cache[entryKey] = {
        fetchedAt: Date.now(),
        reviews: merged.slice(0, MAX_CACHED_REVIEWS),
        cursor: payload.endCursor,
        hasNextPage: payload.hasNextPage,
      };
      writeReviewsCache(cache);

      return payload;
    } catch (e) {
      console.warn('[RMP] reviews fetch failed for', teacher && teacher.firstName, e);
      reviewsFailedAt.set(key, Date.now());
      return null;
    }
  })();

  if (o.force) return promise;
  pendingReviews.set(key, promise);
  promise.catch(() => {}).finally(() => pendingReviews.delete(key));
  return promise;
}