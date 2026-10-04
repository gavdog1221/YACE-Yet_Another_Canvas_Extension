import { state } from '../state.js';
import { STORAGE_KEY_CALENDAR_CACHE } from '../constants.js';
import { localDateKey } from '../utils/dates.js';

// UNH's official academic calendar, as a live iCalendar feed.
//
// www.unh.edu/registrar/calendar is a Drupal page that embeds the registrar's
// calendar as a 25Live/Trumba "spud" (webName: unh-academic-core-calendar),
// which is rendered client-side — nothing useful to scrape. Trumba publishes
// the same calendar as a plain text/calendar feed though, and that IS
// parseable: every entry is an all-day VEVENT carrying SUMMARY, DTSTART, an
// exclusive DTEND, CATEGORIES and a link back to the registrar page.
//
// This is the Registrar's own feed, so it is the authoritative source for
// holidays, breaks, reading days, exam blocks and schedule changes ("classes
// follow a Wednesday schedule"), and it picks up last-minute notices the
// registrar posts — which is how weather/campus-closure days surface here. The
// feed is a rolling window (roughly the next academic year), so a semester
// already in the past naturally rolls out of it.

// The dashboard can't CORS-fetch this host, so it goes through background.js
// (FETCH_UNH_CALENDAR) like every other external site.
export const CALENDAR_ICS_URL = 'https://25livepub.collegenet.com/calendars/unh-academic-core-calendar.ics';
export const CALENDAR_PAGE_URL = 'https://www.unh.edu/registrar/calendar';

// The feed only changes when the registrar edits the calendar (and around
// weather closures), so a 6-hour window is plenty — this is also what keeps
// the "next day off" count from re-rendering against a moving target all day.
const FRESH_MS = 6 * 60 * 60 * 1000;

// Kinds, in the order the view cares about them:
//   off       — no classes (holiday, break, recess, reading day, closure)
//   special   — classes still meet, but differently (Wed schedule, no exams)
//   milestone — informational: classes begin/end, exams begin/end, census day
const KIND_OFF = 'off';
const KIND_SPECIAL = 'special';
const KIND_MILESTONE = 'milestone';

// Titles that mean something was cancelled or moved by weather/safety rather
// than by the ordinary calendar. UNH rarely calls these "snow days", so the
// words actually used are broad on purpose.
const WEATHER_RE = /\b(snow|ice|winter storm|blizzard|weather|closure|closed|clos(ed|ure)\b|campus clos|cancel+l?ed|remote|virtual|delay|delayed|power outage)\b/i;

/* ---------------------------------------------------------------------------
 * ICS parsing
 * ------------------------------------------------------------------------- */

function unescapeIcsText(value) {
  return String(value == null ? '' : value)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
  }

// "20261012" / "20261012T090000" -> "2026-10-12". Day granularity is all this
// feed uses; a time component is ignored on purpose (an all-day academic-calendar
// entry must not drift by timezone when rendered next to a real due date).
function icsValueToDateKey(value) {
  const m = String(value == null ? '' : value).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function blockField(block, name) {
  const re = new RegExp('^' + name + '(?:;[^:\\n]*)?:(.*)$', 'im');
  const m = block.match(re);
  return m ? unescapeIcsText(m[1]) : '';
}

// Multi-day guards: a malformed DTEND (before DTSTART, or absurdly far out)
// must never spin the expander.
const MAX_EVENT_DAYS = 60;

function expandEventDays(startKey, endKey) {
  const days = [];
  if (!startKey) return days;
  const start = new Date(startKey + 'T00:00:00');
  if (isNaN(start.getTime())) return days;

  let last = start;
  if (endKey) {
    const end = new Date(endKey + 'T00:00:00');
    if (!isNaN(end.getTime()) && end > start) last = new Date(end.getTime() - 86400000);
  }

  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= last && guard++ < MAX_EVENT_DAYS) {
    days.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// Order matters: an explicit "no classes" beats a generic "holiday", and both
// beat a schedule change, so read the no-class words first.
function classifyTitle(title) {
  const t = String(title || '').toLowerCase();
  const weather = WEATHER_RE.test(t);

  if (/\bno classes?\b|\bclasses? (?:will )?(?:not|do(?:es)? not) meet\b|\bcancelled?\b|\bcanceled\b/.test(t)) {
    return { kind: KIND_OFF, alert: weather };
  }
  if (/\bholidays?\b|\buniversity holiday\b/.test(t)) return { kind: KIND_OFF, alert: weather };
  if (/\bbreak\b|\brecess\b|\bmid[-\s]?semester\b/.test(t)) return { kind: KIND_OFF, alert: weather };
  if (/\breading day\b/.test(t)) return { kind: KIND_OFF, alert: false };

  if (/\bno exams?\b|\bexams? (?:will )?(?:not|do(?:es)? not) (?:be )?(?:scheduled|given|held)\b/.test(t)) {
    return { kind: KIND_SPECIAL, alert: weather };
  }
  if (/\bschedule\b|\bstart(?:s|ing)? (?:at|late)\b|\bdelayed?\b|\bclasses? (?:will )?begin at\b/.test(t)) {
    return { kind: KIND_SPECIAL, alert: weather };
  }
  if (weather) return { kind: KIND_SPECIAL, alert: true };

  return { kind: KIND_MILESTONE, alert: false };
}

// Compact chip labels for the month grid — the full title is in the cell's
// title attribute and in the detail strip, so the grid only needs a word or two.
function shortLabel(title, kind, alert) {
  if (alert) return 'Alert';
  const t = String(title || '').toLowerCase();
  if (kind === KIND_OFF) {
    if (/\breading day\b/.test(t)) return 'Reading';
    if (/\bbreak\b|\brecess\b|\bmid[-\s]?semester\b/.test(t)) return 'Break';
    if (/\bholiday\b/.test(t)) return 'Holiday';
    if (/\bno classes?\b/.test(t)) return 'No class';
    return 'Day off';
  }
  if (kind === KIND_SPECIAL) {
    if (/\bno exams?\b/.test(t)) return 'No exams';
    if (/\bschedule\b/.test(t)) return 'Alt sched';
    return 'Special';
  }
  return 'Key date';
}

/**
 * Parse the Trumba iCalendar feed into one entry per covered day.
 * Returns { calName, days: [{ date, title, kind, alert, label, url }] } or null
 * when the payload isn't a calendar at all.
 */
export function parseCalendarIcs(ics) {
  const text = String(ics || '');
  if (!text.includes('BEGIN:VEVENT')) return null;

  // RFC 5545 folds long lines ("\r\n " continuation) — unfold before matching,
  // and normalize CRLF so the per-line regexes behave.
  const unfolded = text.replace(/\r?\n[ \t]/g, '').replace(/\r\n/g, '\n');

  const calName = blockField(unfolded.split('BEGIN:VEVENT')[0] || '', 'X-WR-CALNAME');

  const days = [];
  const seen = new Set();
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  for (const block of blocks) {
    const title = blockField(block, 'SUMMARY');
    if (!title) continue;
    const startKey = icsValueToDateKey(blockField(block, 'DTSTART'));
    const endKey = icsValueToDateKey(blockField(block, 'DTEND'));
    const url = blockField(block, 'X-TRUMBA-LINK');
    const category = blockField(block, 'CATEGORIES');
    const meta = classifyTitle(title);
    const label = shortLabel(title, meta.kind, meta.alert);

    const dates = expandEventDays(startKey, endKey);
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      // Same day can carry several entries (e.g. "Fall 2026 Classes Begin" and
      // "Term 1 Classes Begin"); keep them all, dedupe only exact repeats.
      const key = date + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      days.push({
        date,
        title,
        kind: meta.kind,
        alert: meta.alert,
        label,
        url: url || '',
        category,
        // Only the first day of a multi-day entry carries the run length, so
        // the upcoming list can render "Nov 26–27" instead of two rows.
        runLength: dates.length,
        runStart: i === 0,
      });
    }
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { calName, days };
}

/* ---------------------------------------------------------------------------
 * Bundled snapshot — only used when the live feed can't be reached at all.
 * ------------------------------------------------------------------------- */

// Fall 2026 (the semester the widget shipped with). Deliberately hardcoded and
// deliberately labelled as a snapshot in the UI: a stale date list is fine, but
// it must never masquerade as live data. The feed is the source of truth; this
// only keeps the view populated when 25livepub is unreachable.
const SNAPSHOT_ENTRIES = [
  ['2026-08-31', 'Full Semester Classes Begin'],
  ['2026-08-31', 'Term 1 Classes Begin'],
  ['2026-09-07', 'Labor Day, University Holiday'],
  ['2026-10-12', 'Mid-Semester Break; no classes'],
  ['2026-10-13', 'Classes Follow a Wednesday Schedule'],
  ['2026-10-16', 'Mid-Semester'],
  ['2026-10-23', 'Term 1 Last Day of Classes'],
  ['2026-11-02', 'Term 2 Classes Begin'],
  ['2026-11-03', 'Election Day - no exams scheduled'],
  ['2026-11-11', 'Veteran\u2019s Day, University holiday'],
  ['2026-11-25', 'No Classes'],
  ['2026-11-26', 'Thanksgiving holiday'],
  ['2026-11-27', 'Thanksgiving holiday'],
  ['2026-11-30', 'Classes resume'],
  ['2026-12-14', 'Full Semester Last day of classes'],
  ['2026-12-15', 'Reading day, final exams begin at 6:00 p.m.'],
  ['2026-12-22', 'Final Exams end'],
  ['2026-12-24', 'Term 2 Last Day of Classes'],
];

function buildSnapshotDays() {
  const out = [];
  const seen = new Set();
  for (const [date, title] of SNAPSHOT_ENTRIES) {
    if (seen.has(date)) continue;
    seen.add(date);
    const meta = classifyTitle(title);
    out.push({
      date,
      title,
      kind: meta.kind,
      alert: meta.alert,
      label: shortLabel(title, meta.kind, meta.alert),
      url: CALENDAR_PAGE_URL,
      category: 'Academic Core Calendar',
      runLength: 1,
      runStart: true,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/* ---------------------------------------------------------------------------
 * Fetch + cache
 * ------------------------------------------------------------------------- */

function persist(cache) {
  try {
    localStorage.setItem(STORAGE_KEY_CALENDAR_CACHE, JSON.stringify(cache));
  } catch (e) { /* storage full/blocked — keep the in-memory copy */ }
}

function isFresh(cache) {
  return !!(cache && Array.isArray(cache.days) && cache.days.length && (Date.now() - (cache.fetchedAt || 0)) < FRESH_MS);
}

// Failed fetches are rate-limited the same way failed dining days are. This
// matters because neither fallback exit below sets a fresh `fetchedAt` (a
// 'stale' copy keeps its old one, the snapshot hardcodes 0), so isFresh() stays
// false and the next call would happily hit the feed again. Without this
// window a down 25livepub plus any repeat caller — a Retry button, a re-render,
// a future hot-reload path — turns into an unbounded request loop.
const CALENDAR_RETRY_WINDOW_MS = 5 * 60 * 1000;
let calendarFetchFailedAt = 0;

// One in-flight request shared by every concurrent caller, mirroring
// dining-api's pendingDiningFetch. Cleared on settle.
let pendingCalendarFetch = null;

// Resolve the best available copy without touching the network: a previously
// cached day list beats an empty view, and the bundled snapshot beats nothing.
function fallbackCalendar() {
  const cached = state.calendarCache;
  if (cached && Array.isArray(cached.days) && cached.days.length) {
    const stale = Object.assign({}, cached, { source: 'stale' });
    state.calendarCache = stale;
    return stale;
  }
  const snapshot = {
    source: 'snapshot',
    fetchedAt: 0,
    calName: 'UNH Academic Calendar (bundled Fall 2026 snapshot)',
    days: buildSnapshotDays(),
  };
  state.calendarCache = snapshot;
  return snapshot;
}

/**
 * The academic calendar as { source, fetchedAt, calName, days }.
 * `source` is 'live', 'stale' (feed unreachable, cached copy reused) or
 * 'snapshot' (nothing cached yet) so the view can be honest about provenance.
 */
export async function fetchAcademicCalendar(opts) {
  const force = !!(opts && opts.force);
  const cached = state.calendarCache;

  if (!force && isFresh(cached)) return cached;

  // Inside the failure window (or already in flight) there is nothing to gain
  // from another round-trip — hand back whatever we last resolved. `force` is
  // an explicit user action, so it bypasses both.
  if (!force) {
    if (calendarFetchFailedAt && (Date.now() - calendarFetchFailedAt) < CALENDAR_RETRY_WINDOW_MS) {
      return fallbackCalendar();
    }
    if (pendingCalendarFetch) return pendingCalendarFetch;
  }

  const run = (async () => {
    let res = null;
    try {
      res = await browser.runtime.sendMessage({ type: 'FETCH_UNH_CALENDAR' });
    } catch (e) {
      res = null;
    }

    const parsed = res && res.success && res.ics ? parseCalendarIcs(res.ics) : null;
    if (parsed && parsed.days.length) {
      const cache = {
        source: 'live',
        fetchedAt: Date.now(),
        calName: parsed.calName,
        days: parsed.days,
      };
      calendarFetchFailedAt = 0;
      state.calendarCache = cache;
      persist(cache);
      return cache;
    }

    calendarFetchFailedAt = Date.now();
    return fallbackCalendar();
  })();

  if (force) return run;

  pendingCalendarFetch = run;
  // The IIFE swallows its own sendMessage failure, so this cannot reject; the
  // catch is here only so a stray throw never leaves the slot stuck forever.
  run.catch(() => {}).finally(() => { pendingCalendarFetch = null; });
  return run;
}

/* ---------------------------------------------------------------------------
 * Queries over the cached day list
 * ------------------------------------------------------------------------- */

// date -> entries[]
export function indexDaysByDate(cache) {
  const map = new Map();
  const days = (cache && cache.days) || [];
  for (const entry of days) {
    const list = map.get(entry.date);
    if (list) list.push(entry);
    else map.set(entry.date, [entry]);
  }
  return map;
}

// The strongest kind on a given day, so a cell with both a milestone and a
// break still renders as a day off.
const KIND_RANK = { [KIND_OFF]: 3, [KIND_SPECIAL]: 2, [KIND_MILESTONE]: 1 };

export function dominantKind(entries) {
  let best = KIND_MILESTONE;
  let alert = false;
  for (const entry of entries || []) {
    if (KIND_RANK[entry.kind] > KIND_RANK[best]) best = entry.kind;
    if (entry.alert) alert = true;
  }
  return { kind: best, alert };
}

export function isDayOffKind(kind) {
  return kind === KIND_OFF || kind === KIND_SPECIAL;
}

// Days off on/after today, collapsed so a multi-day break is one row instead
// of N. `kinds` filters which kinds count (the "Days off" vs "All key dates"
// pills).
//
// The feed is inconsistent about spans, and dates carry several titles at once,
// so runs are tracked per title across date groups rather than by walking a flat
// day list:
//   - some breaks arrive as one VEVENT (DTSTART 20270322 / DTEND 20270327),
//     others as one VEVENT per day (each Thanksgiving date gets its own);
//   - Nov 27 2026 carries BOTH "Thanksgiving Holidays" and "Fall Term 2
//     2026 Midsemester", so a flat walk breaks the Thanksgiving run in half.
//
// Runs come back in start-date order.
export function upcomingRuns(cache, kinds, limit, fromDate) {
  const today = fromDate || localDateKey(new Date());
  const wanted = new Set(kinds && kinds.length ? kinds : [KIND_OFF, KIND_SPECIAL]);

  const byDate = indexDaysByDate(cache);
  const dates = Array.from(byDate.keys()).sort();

  const runs = [];
  const open = new Map(); // title -> run still eligible to extend
  let prevDate = null;

  for (const date of dates) {
    const entries = (byDate.get(date) || []).filter(e => wanted.has(e.kind));
    const adjacent = !!prevDate && date === nextDateKey(prevDate);
    const live = new Set();

    for (const entry of entries) {
      const run = open.get(entry.title);
      if (adjacent && run && run.end === prevDate) {
        run.end = date;
        run.days += 1;
        run.alert = run.alert || entry.alert;
      } else {
        const fresh = {
          start: date,
          end: date,
          title: entry.title,
          kind: entry.kind,
          alert: entry.alert,
          label: entry.label,
          url: entry.url,
          days: 1,
        };
        runs.push(fresh);
        open.set(entry.title, fresh);
      }
      live.add(entry.title);
    }

    // A title absent today can never extend again, so stop holding it open.
    for (const title of Array.from(open.keys())) {
      if (!live.has(title)) open.delete(title);
    }
    prevDate = date;
  }

  const upcoming = runs.filter(r => r.end >= today);
  return limit ? upcoming.slice(0, limit) : upcoming;
}

export function nextDateKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  if (isNaN(d.getTime())) return dateKey;
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

// Whole days from today until `dateKey` (0 = today).
export function daysUntil(dateKey, fromDate) {
  const today = fromDate ? new Date(fromDate + 'T00:00:00') : new Date();
  const target = new Date(dateKey + 'T00:00:00');
  if (isNaN(today.getTime()) || isNaN(target.getTime())) return 0;
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

// Count of day-off days inside one month, for the header summary.
// Counts DISTINCT DATES, not entries: the feed legitimately posts more than
// one VEVENT for a single date (Nov 27 2026 carries both "Thanksgiving
// Holidays" and "Fall Term 2 2026 Midsemester", and a holiday that also has no
// classes arrives twice), so counting entries reported "4 days off" for a
// 3-day stretch. A Set keyed on the date matches how the month grid paints.
export function countDaysOffInMonth(cache, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const dates = new Set();
  for (const entry of (cache && cache.days) || []) {
    if (entry.date.indexOf(prefix) !== 0) continue;
    if (entry.kind === KIND_OFF) dates.add(entry.date);
  }
  return dates.size;
}