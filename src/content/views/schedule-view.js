import { state } from '../state.js';
import { computeTimeConflicts, formatTime, parseMeetDays, scheduleLabel, toMinutes } from '../../shared/schedule-conflicts.js';
import { getHiddenCourses } from '../storage/hidden-courses.js';
import { CUSTOM_COLOR_PRESETS, STORAGE_KEY_SCHEDULE_CACHE, STORAGE_KEY_SCHEDULE_SELECTIONS } from '../constants.js';
import { escapeHTML, normalizeCourseCode } from '../utils/text.js';
import { parseColorToRgba } from '../utils/colors.js';

// Schedule panel: a weekly timetable of the classes the user is *currently*
// taking. Courses come from the Canvas dashboard scrape (state.cachedCourseMap
// — skip custom/self-made courses and hidden ones), then each catalog code is
// looked up on courses.unh.edu via the background relay:
//   1. FETCH_COURSE_SEARCH { query: code, termCode } → current-term sections
//   2. FETCH_WEBCAT_CRN { crns, termCode } → meeting days/start/end/building
// The current term is derived from today's date (UNH scheme: <year><season>,
// fall=10, january=30, spring=50, summer=70). Every scraped lecture/lab is
// kept, and the "Choose sections" picker lets the user pick which lecture —
// and, when the course has them, which lab — actually goes on the timetable.
// Those CRN choices persist per term in localStorage
// (STORAGE_KEY_SCHEDULE_SELECTIONS). Results are cached per (term · course-set)
// so interactive dashboard re-renders never refetch, and the whole panel
// renders whenever a loadTasks rebuild reaches it.
//
// This is deliberately independent of the WebCat Reg tab — that one holds
// CRNs for *registering for next semester*, not the current schedule.

const SCHEDULE_CACHE_MS = 12 * 60 * 60 * 1000;
const ROW_MINUTES = 30;
const DAY_ORDER = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];
const DAY_LABELS = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri', S: 'Sat', U: 'Sun' };
const SEASON_SUFFIX = { 10: 'Fall', 30: 'January', 50: 'Spring', 70: 'Summer' };

// UNH term codes are deterministic from the calendar: <year><season> with
// fall=10, january=30, spring=50, summer=70.
function currentTermCode(now) {
    const m = now.getMonth(); // 0 = January
    const season = m === 0 ? '30' : m <= 4 ? '50' : m <= 7 ? '70' : '10';
    return String(now.getFullYear()) + season;
}

// "202610" -> "Fall 2026"
function termLabel(code) {
    const s = String(code || '');
    const year = s.slice(0, 4);
    const season = SEASON_SUFFIX[s.slice(4)];
    return year && season ? `${season} ${year}` : (s || '');
}

// "MATH 425 (01) - Calculus II" -> "MATH 425" (lowercase-tolerant, honors
// letter kept). Section tokens may be "01", "L05", "NL2" or "M1". '' when the
// node isn't a course-section title.
function parseCourseCode(title) {
    const m = String(title || '').match(/^([A-Za-z]{2,5}\s*\d{3}[A-Za-z]?)\s*\([A-Za-z0-9]{1,5}\)/);
    return m ? m[1].replace(/\s+/g, ' ').toUpperCase() : '';
}

// Sections carry their section token in `code` ("CHEM 403-L05"). The base
// catalog code is everything before that suffix, so lectures and labs from the
// same course stay in one picker group.
function catalogBaseCode(code) {
    const m = String(code || '').toUpperCase().match(/^([A-Z]{2,5}\s*\d{3})(?:-[A-Z0-9]{1,5})?$/);
    return m ? m[1] : normalizeCourseCode(code);
}

function sectionToken(section) {
    if (section && section.section) return String(section.section);
    const m = String((section && section.code) || '').match(/-([A-Za-z0-9]{1,5})$/);
    return m ? m[1].toUpperCase() : '';
}

// Labs are marked by the section component ("... Lab") on courses.unh.edu.
// The L-prefixed token convention (L01/LM1; not NL1) is a fallback for older
// cached payloads and departments whose subtitle omits "Lab".
function isLabSection(section) {
    const component = String((section && section.component) || '');
    if (/\blab(?:oratory)?\b/i.test(component)) return true;
    return /^L[A-Z]?\d+$/i.test(sectionToken(section));
}

function compareSections(a, b) {
    const ta = sectionToken(a);
    const tb = sectionToken(b);
    const na = /^\d+$/.test(ta);
    const nb = /^\d+$/.test(tb);
    if (na !== nb) return na ? -1 : 1;
    if (na && nb) return parseInt(ta, 10) - parseInt(tb, 10);
    return ta.localeCompare(tb, undefined, { numeric: true });
}

function loadSelections() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_SCHEDULE_SELECTIONS) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function selectionKey(termCode, courseCode) {
    return `${termCode}|${courseCode}`;
}

// Persist one course's lecture/lab choice. Choices are scoped to the term so
// next semester starts fresh instead of silently applying old CRNs.
function saveSelection(termCode, courseCode, kind, crn) {
    const all = loadSelections();
    const key = selectionKey(termCode, courseCode);
    const current = all[key] || {};
    if (kind === 'lecture') {
        if (crn) current.lecture = String(crn);
        else delete current.lecture;
    } else if (kind === 'lab') {
        if (crn) current.lab = String(crn);
        else delete current.lab;
    }
    if (current.lecture || current.lab) all[key] = current;
    else delete all[key];
    try {
        localStorage.setItem(STORAGE_KEY_SCHEDULE_SELECTIONS, JSON.stringify(all));
    } catch (e) {}
}

// The courses the user is currently in on Canvas, reduced to their catalog
// codes ("CS 501", "MATH 425-01" -> "MATH 425"). Custom self-made courses and
// hidden ones are skipped; anything without a real course-code pattern is too.
function collectCurrentCourses() {
    const hiddenCourses = getHiddenCourses();
    const map = state.cachedCourseMap || {};
    const codes = [];
    const seen = new Set();
    Object.keys(map).forEach(key => {
        const course = map[key];
        if (course && course.isCustomCourse) return;
        if (hiddenCourses.includes(key)) return;
        const code = normalizeCourseCode(key).replace(/-.*$/, '').trim();
        if (!/^[A-Z]{2,5}\s*\d{3}$/.test(code)) return;
        if (!seen.has(code)) {
            seen.add(code);
            codes.push(code);
        }
    });
    return codes.sort();
}

async function fetchSearchMatches(code, termCode) {
    try {
        const msg = await browser.runtime.sendMessage({ type: 'FETCH_COURSE_SEARCH', query: code, termCode });
        if (!msg || !msg.success) return [];
        return (msg.matches || []).filter(m =>
            String(m.termCode) === termCode && parseCourseCode(m.title) === code);
    } catch (e) {
        return [];
    }
}

// Fetch meeting details for a batch of CRNs. The background caps each message
// at 12 CRNs, so chunk and run the chunks in parallel — lab courses can have
// 20+ sections and waiting for them one at a time is noticeably slow.
async function fetchSections(crns, termCode) {
    const chunks = [];
    for (let i = 0; i < crns.length; i += 12) chunks.push(crns.slice(i, i + 12));
    const batches = await Promise.all(chunks.map(async chunk => {
        try {
            const msg = await browser.runtime.sendMessage({ type: 'FETCH_WEBCAT_CRN', crns: chunk, termCode });
            if (msg && msg.success && Array.isArray(msg.sections)) return msg.sections;
        } catch (e) {}
        return [];
    }));
    return batches.flat();
}

// Search each current course code and pull meeting details for every section
// in the current term — lectures and labs. Runs the per-course searches in
// parallel; the background's course-page cache absorbs repeated CRNs.
async function loadScheduleSections(courseCodes, termCode, force) {
    const cacheKey = `${termCode}|${courseCodes.join(',')}`;
    if (!force) {
        const cached = loadCache();
        if (cached && cached.key === cacheKey && Date.now() - cached.savedAt < SCHEDULE_CACHE_MS) {
            return Array.isArray(cached.sections) ? cached.sections : [];
        }
    }

    const seenCrn = new Set();
    const sections = [];
    await Promise.all(courseCodes.map(async code => {
        const matches = await fetchSearchMatches(code, termCode);
        const wanted = matches.filter(m => {
            if (seenCrn.has(m.crn)) return false;
            seenCrn.add(m.crn);
            return true;
        });
        if (!wanted.length) return;
        const fetched = await fetchSections(wanted.map(m => m.crn), termCode);
        fetched.forEach(section => {
            if (!section) return;
            if (!section.code) section.code = code;
            sections.push(section);
        });
    }));

    // Keep every section. The schedule tab's per-course pickers need the full
    // list; collapsing identical code+time blocks here would make alternative
    // sections (and most labs) impossible to choose.
    saveCache({ key: cacheKey, savedAt: Date.now(), sections });
    return sections;
}

function loadCache() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY_SCHEDULE_CACHE) || 'null');
    } catch {
        return null;
    }
}

function saveCache(cache) {
    try {
        localStorage.setItem(STORAGE_KEY_SCHEDULE_CACHE, JSON.stringify(cache));
    } catch (e) {}
}

// Deterministic per-course accent from the custom-assignment color presets so
// every course's blocks stay the same color across renders.
function courseColor(courseKey) {
    let hash = 0;
    for (let i = 0; i < courseKey.length; i++) hash = (hash * 31 + courseKey.charCodeAt(i)) | 0;
    const accent = CUSTOM_COLOR_PRESETS[Math.abs(hash) % CUSTOM_COLOR_PRESETS.length];
    const soft = parseColorToRgba(accent, 0.18) || 'rgba(10, 132, 255, 0.18)';
    const glow = parseColorToRgba(accent, 0.5) || 'rgba(10, 132, 255, 0.5)';
    return { accent, soft, glow };
}

// "540" -> "9:00" (labels only — AM/PM is redundant next to a time axis)
function timeLabel(minutes) {
    let h = Math.floor(minutes / 60);
    const m = minutes % 60;
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')}`;
}

// Flattens sections into positioned blocks and derives the grid bounds
// (day columns present, first/last meeting minute, row count).
function buildGridData(sections, hiddenCourses) {
    const blocks = [];
    const daySet = new Set();
    let minStart = 8 * 60;
    let maxEnd = 20 * 60;
    (sections || []).forEach(s => {
        if (s.error) return;
        const days = parseMeetDays(s.days);
        const start = toMinutes(s.start);
        const end = toMinutes(s.end);
        if (!days.length || start === null || end === null || start >= end) return;
        const key = normalizeCourseCode(s.code);
        if (key && hiddenCourses.includes(key)) return;
        days.forEach(d => daySet.add(d));
        minStart = Math.min(minStart, start);
        maxEnd = Math.max(maxEnd, end);
        blocks.push({ section: s, days, start, end });
    });
    minStart = Math.floor(minStart / ROW_MINUTES) * ROW_MINUTES;
    if (maxEnd - minStart > 16 * 60) maxEnd = minStart + 16 * 60; // sanity cap
    const duration = Math.max(maxEnd - minStart, 60);
    const dayList = DAY_ORDER.filter(d => daySet.has(d));
    const rows = Math.max(Math.round(duration / ROW_MINUTES), 8);
    return {
        blocks,
        days: dayList.length ? dayList : ['M', 'T', 'W', 'R', 'F'],
        minStart,
        duration,
        rows,
    };
}

// Group scraped sections by catalog code, splitting lectures from labs so the
// picker can offer one of each. Course codes with no scraped sections still
// produce an (empty) group, which surfaces "No sections found" in the picker.
function groupSectionsByCourse(sections, courseCodes) {
    const groups = new Map();
    (courseCodes || []).forEach(code => groups.set(code, { code, lectures: [], labs: [] }));
    (sections || []).forEach(section => {
        if (!section || section.error) return;
        const code = catalogBaseCode(section.code);
        if (!groups.has(code)) groups.set(code, { code, lectures: [], labs: [] });
        const group = groups.get(code);
        (isLabSection(section) ? group.labs : group.lectures).push(section);
    });
    groups.forEach(group => {
        group.lectures.sort(compareSections);
        group.labs.sort(compareSections);
    });
    return Array.from(groups.values());
}

// Saved CRN wins when it still exists in the scrape; otherwise fall back to
// the first lecture. Labs stay opt-in (no lab) unless the course has no lecture
// sections at all, in which case a lab-only course defaults to its first lab.
function resolveCourseSelection(group, selections, termCode) {
    const saved = selections[selectionKey(termCode, group.code)] || {};
    const lecture = group.lectures.find(s => String(s.crn) === String(saved.lecture || ''))
        || group.lectures[0] || null;
    const lab = group.labs.find(s => String(s.crn) === String(saved.lab || ''))
        || (!lecture ? group.labs[0] || null : null);
    return { lecture, lab };
}

function isOnlineSection(section) {
    return !(section.days && section.days.length) && !section.start && !section.end
        && /online/i.test(section.title || '');
}

// "Sec 01 — MWF 9:00–10:15 AM · PARS N108"
function sectionOptionLabel(section, kind) {
    const token = sectionToken(section) || '—';
    const place = [section.building, section.room].filter(Boolean).join(' ');
    const bits = [scheduleLabel(section, { online: isOnlineSection(section) }), place].filter(Boolean);
    return `${kind === 'lab' ? 'Lab' : 'Sec'} ${token}${bits.length ? ' — ' + bits.join(' · ') : ''}`;
}

function renderSectionPicker(termCode, groups, selections, open) {
    if (!groups.length) return '';
    const rows = groups.map(group => {
        const choice = resolveCourseSelection(group, selections, termCode);
        const lectureOptions = group.lectures.length
            ? group.lectures.map(s => `<option value="${escapeHTML(s.crn)}" ${choice.lecture && String(s.crn) === String(choice.lecture.crn) ? 'selected' : ''}>${escapeHTML(sectionOptionLabel(s, 'lecture'))}</option>`).join('')
            : '<option value="">No sections found</option>';
        const labOptions = group.labs.length
            ? `<option value="" ${choice.lab ? '' : 'selected'}>No lab</option>` + group.labs.map(s => `<option value="${escapeHTML(s.crn)}" ${choice.lab && String(s.crn) === String(choice.lab.crn) ? 'selected' : ''}>${escapeHTML(sectionOptionLabel(s, 'lab'))}</option>`).join('')
            : '';
        return `
        <div class="sched-picker-row">
            <span class="sched-picker-course">${escapeHTML(group.code)}</span>
            <label class="sched-picker-field"><span>Class</span>
                <select data-course="${escapeHTML(group.code)}" data-kind="lecture" ${group.lectures.length ? '' : 'disabled'}>${lectureOptions}</select>
            </label>
            ${group.labs.length ? `<label class="sched-picker-field sched-picker-lab"><span>Lab</span>
                <select data-course="${escapeHTML(group.code)}" data-kind="lab">${labOptions}</select>
            </label>` : ''}
        </div>`;
    }).join('');
    const count = groups.length;
    return `
    <details class="sched-picker" ${open ? 'open' : ''}>
        <summary>Choose sections <span class="sched-picker-sub">${count} course${count === 1 ? '' : 's'}</span></summary>
        <div class="sched-picker-list">${rows}</div>
    </details>`;
}

function renderScheduleGrid(container, sections, courseCodes, termCode, options = {}) {
    const courseCount = courseCodes.length;
    const hiddenCourses = getHiddenCourses();
    const valid = (sections || []).filter(s => !s.error);
    const errors = (sections || []).filter(s => s.error);
    const groups = groupSectionsByCourse(valid, courseCodes);
    const selections = loadSelections();

    // Only the chosen lecture + lab for each course make it onto the grid.
    const selected = [];
    groups.forEach(group => {
        const choice = resolveCourseSelection(group, selections, termCode);
        if (choice.lecture) selected.push(choice.lecture);
        if (choice.lab) selected.push(choice.lab);
    });

    const conflicts = computeTimeConflicts(selected);
    const withTimes = selected.filter(s => {
        const start = toMinutes(s.start);
        const end = toMinutes(s.end);
        return parseMeetDays(s.days).length && start !== null && end !== null && start < end;
    });
    const noMeetingTime = selected.filter(s => !withTimes.includes(s));
    const { blocks, days, minStart, duration, rows } = buildGridData(selected, hiddenCourses);

    // Auto-open the picker on first use only when a course actually has choices
    // to make; afterwards it stays collapsed unless the user opened it.
    const anySaved = groups.some(group => {
        const saved = selections[selectionKey(termCode, group.code)];
        return !!(saved && (saved.lecture || saved.lab));
    });
    const needsChoice = groups.some(group => group.lectures.length > 1 || group.labs.length);
    const pickerOpen = options.pickerOpen !== undefined
        ? !!options.pickerOpen
        : (!anySaved && needsChoice);
    const pickerHtml = renderSectionPicker(termCode, groups, selections, pickerOpen);

    const termHtml = `<span class="sched-term">${escapeHTML(termLabel(termCode))}</span>`;
    const countLabel = `<span class="sched-crns">${courseCount} course${courseCount === 1 ? '' : 's'}</span>`;
    const topbar = `<div class="sched-topbar">${termHtml}${countLabel}<button type="button" class="sched-refresh-btn">↻ Refresh</button></div>`;
    const conflictHtml = conflicts.length ? `
        <div class="sched-conflict-warn">⚠ ${conflicts.length} time conflict${conflicts.length === 1 ? '' : 's'} between your classes</div>` : '';

    const nonAttendHtml = noMeetingTime.length ? `
        <div class="sched-nonattend"><span class="sched-na-title">No set meeting time</span>
        ${noMeetingTime.map(s => `<span class="sched-na-chip">${escapeHTML(s.code || ('CRN ' + s.crn))} · ${escapeHTML(scheduleLabel(s, { online: isOnlineSection(s) }))}</span>`).join('')}
        </div>` : '';

    const errorHtml = errors.length ? `
        <div class="sched-nonattend sched-errors">${errors.map(s => `<span class="sched-na-chip sched-error-chip">CRN ${escapeHTML(s.crn)} — ${escapeHTML(s.error)}</span>`).join('')}</div>` : '';

    if (!blocks.length) {
        container.innerHTML = topbar + conflictHtml + pickerHtml + `
        <div class="sched-empty">No published class times found for your current courses in ${escapeHTML(termLabel(termCode))} — sections may be online, TBA, or not yet published on courses.unh.edu.</div>` + nonAttendHtml + errorHtml;
    } else {
        const dayCount = days.length;
        const headerCells = ['<div class="sched-corner">Time</div>'];
        days.forEach(d => headerCells.push(`<div class="sched-dayhead">${DAY_LABELS[d]}</div>`));
        let timeRows = '';
        for (let r = 0; r < rows; r++) {
            timeRows += `<div class="sched-timelabel">${timeLabel(minStart + r * ROW_MINUTES)}</div>`;
        }
        const dayCells = days.map((d, idx) => {
            const col = idx + 2;
            const cellBlocks = blocks.filter(b => b.days.includes(d)).map(b => {
                const top = ((b.start - minStart) / duration) * 100;
                const height = ((b.end - b.start) / duration) * 100;
                const color = courseColor(normalizeCourseCode(b.section.code) || b.section.crn);
                const place = [b.section.building, b.section.room].filter(Boolean).join(' ');
                const bits = [`${formatTime(b.section.start)}–${formatTime(b.section.end)}`, place].filter(Boolean).join(' · ');
                const meta = height > 13 ? `<span class="sched-block-meta">${escapeHTML(bits)}</span>` : '';
                return `
                <div class="sched-block" style="top:${top}%;height:${height}%;--sched-accent:${color.accent};--sched-soft:${color.soft};--sched-glow:${color.glow};" title="${escapeHTML(b.section.code || ('CRN ' + b.section.crn))} — ${escapeHTML(b.section.title || '')}">
                    <span class="sched-block-code">${escapeHTML(b.section.code || ('CRN ' + b.section.crn))}</span>
                    <span class="sched-block-title">${escapeHTML(b.section.title || '')}</span>
                    ${meta}
                </div>`;
            }).join('');
            return `<div class="sched-day" style="grid-column:${col};grid-row:2 / span ${rows};">${cellBlocks}</div>`;
        }).join('');

        container.innerHTML = topbar + conflictHtml + pickerHtml +
            `<div class="sched-grid" style="--sched-cols:${dayCount};">${headerCells.join('')}${timeRows}${dayCells}</div>` +
            nonAttendHtml + errorHtml;
    }

    container.querySelectorAll('.sched-picker select').forEach(select => {
        select.addEventListener('change', () => {
            saveSelection(termCode, select.getAttribute('data-course'), select.getAttribute('data-kind'), select.value);
            renderScheduleGrid(container, sections, courseCodes, termCode, { pickerOpen: true });
        });
    });
    const refresh = container.querySelector('.sched-refresh-btn');
    if (refresh) refresh.addEventListener('click', () => renderScheduleView(container, true));
}

export async function renderScheduleView(container, force = false) {
    container.innerHTML = `<div class="sched-empty"><span class="sched-loading">Loading your schedule…</span></div>`;

    const termCode = currentTermCode(new Date());
    const courseCodes = collectCurrentCourses();

    if (!courseCodes.length) {
        container.innerHTML = `
        <div class="sched-empty">
            <div class="sched-empty-title">No schedule yet</div>
            <p>The schedule is built from the courses you're currently in on Canvas. No catalog-code courses were found.</p>
        </div>`;
        return;
    }

    const sections = await loadScheduleSections(courseCodes, termCode, force);
    if (sections && sections.error) {
        container.innerHTML = `
        <div class="sched-empty">
            <div class="sched-empty-title">Couldn't load your schedule</div>
            <p>${escapeHTML(sections.error)}</p>
            <button type="button" class="sched-refresh-btn">↻ Retry</button>
        </div>`;
        const retry = container.querySelector('.sched-refresh-btn');
        if (retry) retry.addEventListener('click', () => renderScheduleView(container, true));
        return;
    }

    renderScheduleGrid(container, sections, courseCodes, termCode);
}