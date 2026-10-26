import { state } from '../state.js';
import { origin } from '../constants.js';
import { isCurrentSemesterCourse } from '../utils/dates.js';
import { generateTaskId, normalizeCourseCode, parseAndCleanTitle } from '../utils/text.js';

export function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

// Canvas List endpoints paginate at their per_page cap via Link: rel="next"
// — the old code fetched one page and silently truncated anything beyond it
// (a student with >100 courses, >100 assignments in a course, or >50 graded
// submissions). Follows the pagination chain with a sanity cap so a runaway
// loop can't hammer the API forever. Returns the flat concatenated array
// ([] when the first request fails, so callers keep their existing fallbacks).
export async function fetchAllPages(firstUrl, headers, maxPages = 5) {
    const out = [];
    let url = firstUrl;
    for (let page = 0; url && page < maxPages; page++) {
      try {
        const res = await fetch(url, { credentials: 'include', headers: headers });
        if (!res.ok) break;
        const data = await res.json();
        if (Array.isArray(data)) out.push(...data);
        const link = res.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
        url = next ? next[1] : null;
      } catch (e) {
        console.warn('[YACE] paginated fetch failed at page', page + 1, e);
        break;
      }
    }
    return out;
  }

// Conservative parse of a Gradescope due cell's visible text for a submission
// WINDOW — e.g. "Sep 22 – Sep 24" or "9/22 - 9/24". Used only as a fallback
// when the row exposes no <time datetime> elements at all. Returns epoch-ms
// dates for every bound found (caller takes the latest as the due date).
function parseGradescopeWindowDates(text) {
    const year = new Date().getFullYear();
    const monthRe = /([a-zA-Z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:[-–—]|to|through)\s*([a-zA-Z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?/i;
    const m = text.match(monthRe);
    if (m) {
      const a = new Date(`${m[1]} ${m[2]}, ${year}`).getTime();
      const b = new Date(`${m[3]} ${m[4]}, ${year}`).getTime();
      if (!isNaN(a) && !isNaN(b)) return [a, b];
    }
    const numRe = /(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?\s*(?:[-–—]|to|through)\s*(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?/i;
    const n = text.match(numRe);
    if (n) {
      const yearA = n[3] ? (n[3].length === 2 ? '20' + n[3] : n[3]) : String(year);
      const yearB = n[6] ? (n[6].length === 2 ? '20' + n[6] : n[6]) : yearA;
      const a = new Date(`${n[1]}/${n[2]}/${yearA}`).getTime();
      const b = new Date(`${n[4]}/${n[5]}/${yearB}`).getTime();
      if (!isNaN(a) && !isNaN(b)) return [a, b];
    }
    return [];
  }

// Reading a cell as plain text FUSES adjacent inline elements with no separator
// between them: Gradescope renders a graded row as
// `<span>5.0 / 5.0</span><span>100%</span>`, and innerText reads that back as
// "5.0 / 5.0100%" — the max points silently swallow the first digit of the
// percentage, so a perfect 5/5 homework showed up as "5 out of 5.01". Joining
// every text node with a space keeps each number whole.
function readSpacedText(root) {
    if (!root) return '';
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const tag = node.parentNode && node.parentNode.nodeName;
        return (tag === 'SCRIPT' || tag === 'STYLE') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

// Convert a Gradescope score cell's text into { score, pointsPossible }.
//
// The score itself is "<score> / <max>" (rendered with a decimal, e.g.
// "5.0 / 5.0"), but a percentage printed right next to it can still end up
// fused on to the max ("5.0" + "100%" -> 5.0100). When that happens the "%"
// after the digits pins the real max down: walk back from the digit run trying
// shorter spellings ("5.0100" -> "5.010" -> "5.01" -> "5.0" -> "5") and keep
// the longest one whose implied percentage (score / max) matches the
// percentage that follows it. Nothing is trimmed unless the numbers left over
// after the fraction prove the trim right, so a plain "4.5 / 5.5 81.8%" row
// keeps its real max.
function parseGradescopeScore(text) {
    const raw = (text || '').trim();
    if (!raw) return null;
    const m = raw.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;

    const score = parseFloat(m[1]);
    const maxStr = m[2];
    const maxVal = parseFloat(maxStr);
    if (isNaN(score) || isNaN(maxVal)) return null;

    // The whitespace-free run right after the fraction ("" when the source has
    // proper separators); anything glued on here is the suspect.
    const tail = (raw.slice(m.index + m[0].length).match(/^\S*/) || [''])[0];
    const run = maxStr + tail;

    let bestStr = maxStr;
    let bestErr = Infinity;
    // Longest spelling first, so a tie keeps the value closest to the page.
    for (let end = maxStr.length; end > 0; end--) {
      const candStr = maxStr.slice(0, end);
      if (candStr.endsWith('.')) continue;
      const cand = parseFloat(candStr);
      if (!(cand > 0)) continue;
      // e.g. run "5.0100%" offers "5.0" + "100%" or "5.01" + "00%".
      const pctM = run.slice(end).match(/^(\d*\.?\d+)\s*%/);
      if (!pctM) continue;
      const pct = parseFloat(pctM[1]);
      if (!(pct > 0)) continue;
      const err = Math.abs((score / cand) * 100 - pct);
      if (err < bestErr) {
        bestErr = err;
        bestStr = candStr;
      }
    }

    // Only trust a shorter spelling when it makes the fraction and the
    // percentage agree (Gradescope rounds them, so allow a little slack);
    // otherwise those digits really are the max points.
    const pointsPossible = bestErr <= 1.5 ? parseFloat(bestStr) : maxVal;
    return { score: score, pointsPossible: pointsPossible };
  }

export async function fetchGradescopeData(hiddenCourseKeys = []) {
    const gsTasksByCourse = {};
    const gsGradesByCourse = {};
    // Normalized course code -> that course's Gradescope page. The Info panel
    // links to it, so it has to be collected even when a course produced no
    // tasks/grades (an empty Gradescope course still has a page worth opening).
    const gsCourseUrlsByKey = {};

    try {
      let dashRes = await fetch('https://www.gradescope.com/', { credentials: 'include' });
      if (!dashRes.ok) {
        dashRes = await fetch('https://www.gradescope.com/courses', { credentials: 'include' });
      }
      if (!dashRes.ok) return { tasksByCourse: gsTasksByCourse, gradesByCourse: gsGradesByCourse, courseUrlsByCourse: gsCourseUrlsByKey };

      const htmlText = await dashRes.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');

      const courseLinks = Array.from(doc.querySelectorAll('a[href*="/courses/"]'));
      const courseMap = new Map();

      courseLinks.forEach(el => {
        const href = el.getAttribute('href');
        const match = href ? href.match(/\/courses\/(\d+)$/) : null;
        if (!match) return;

        const courseId = match[1];
        const fullUrl = `https://www.gradescope.com/courses/${courseId}`;
        const titleEl = el.querySelector('h3, .courseBox--shortname, .courseBox--name') || el;
        let name = titleEl.innerText.split('\n')[0].trim().replace(/\s+/g, ' ');

        if (!isCurrentSemesterCourse(name)) return;
        // Hidden courses aren't scraped anywhere else — skip their per-course
        // page fetch here too (it's one request per Gradescope course).
        if (hiddenCourseKeys.includes(normalizeCourseCode(name))) return;
        if (!courseMap.has(courseId) && name) {
          courseMap.set(courseId, { id: courseId, name: name, url: fullUrl });
          gsCourseUrlsByKey[normalizeCourseCode(name)] = fullUrl;
        }
      });

      // Fetch every GS course through a capped worker pool (4 lanes) instead
      // of an unbounded Promise.all — one request per course hit gradescope
      // with no rate limit before.
      const gsQueue = Array.from(courseMap.values());
      const gsWorkers = Array.from({ length: Math.min(4, gsQueue.length) }, async () => {
        while (gsQueue.length) {
          const course = gsQueue.shift();
          try {
          const cRes = await fetch(course.url, { credentials: 'include' });
          if (!cRes.ok) continue;

          const cHtml = await cRes.text();
          const cDoc = parser.parseFromString(cHtml, 'text/html');
          const rows = Array.from(cDoc.querySelectorAll('tbody tr'));
          const tasks = [];
          const grades = [];
          const courseKey = normalizeCourseCode(course.name);

          rows.forEach(row => {
            const btnEl = row.querySelector('button.js-submitAssignment, [data-assignment-title]');
            const linkEl = row.querySelector('.table--primaryLink a, a[href*="/assignments/"]');

            let title = '';
            if (btnEl) title = btnEl.getAttribute('data-assignment-title') || btnEl.innerText.trim();
            else if (linkEl) title = linkEl.innerText.trim();
            else {
              const th = row.querySelector('th');
              if (th) title = th.innerText.trim();
            }

            title = title.split('\n')[0].trim();
            if (!title || title.toLowerCase() === 'name') return;

            let url = course.url;
            let uploadUrl = null;

            if (btnEl && btnEl.getAttribute('data-post-url')) {
              const postUrl = btnEl.getAttribute('data-post-url');
              url = `https://www.gradescope.com${postUrl.replace(/\/submissions.*$/, '')}`;
              uploadUrl = `https://www.gradescope.com${postUrl}`;
            } else if (linkEl && linkEl.getAttribute('href')) {
              url = `https://www.gradescope.com${linkEl.getAttribute('href')}`;
              uploadUrl = url;
            }

            const statusEl = row.querySelector('.submissionStatus--text, .submissionStatus');
            const statusText = statusEl ? statusEl.innerText.trim() : '';
            // Read the score cell with separators between its text nodes (see
            // readSpacedText) so a glued-on percentage can't inflate the max,
            // then let parseGradescopeScore undo any fusion that survived.
            const score = parseGradescopeScore(readSpacedText(statusEl || row));

            if (score) {
              grades.push({
                id: generateTaskId(courseKey, title) + '_grade',
                          title: title,
                          score: score.score,
                          pointsPossible: score.pointsPossible,
                          url: url,
                          gradedAt: null,
                          isGradescope: true,
                          courseKey: courseKey,
                          courseName: course.name
              });
              return;
            }

            const hasActiveSubmission = /submitted/i.test(statusText) && !/no submission/i.test(statusText);

            // Assignments can open a submission WINDOW ("Sep 22 – Sep 24"): the row's
            // due chart may carry BOTH datetimes, and querySelector only returns
            // the FIRST match. Keep the range: the window OPEN bound is the due
            // date (Sep 22) and the CLOSE bound is the late date (Sep 24).
            // When no datetime elements exist (dates rendered as plain text),
            // fall back to a conservative text-range parse.
            let dueDate = null;
            let gsLateDate = null;
            const gsDueTimes = [];
            row.querySelectorAll('time[datetime]').forEach(tag => {
              const v = tag.getAttribute('datetime');
              if (!v) return;
              const d = new Date(v);
              if (!isNaN(d.getTime())) gsDueTimes.push(d.getTime());
            });
            if (!gsDueTimes.length) {
              gsDueTimes.push(...parseGradescopeWindowDates(row.innerText || ''));
            }
            if (gsDueTimes.length) {
              const earliest = Math.min(...gsDueTimes);
              const latest = Math.max(...gsDueTimes);
              dueDate = new Date(earliest);
              if (latest > earliest) gsLateDate = new Date(latest);
            }

            const cleanedGs = parseAndCleanTitle(title, courseKey);
            tasks.push({
              id: generateTaskId(courseKey, title),
                       title: cleanedGs.title,
                       url: url,
                       gradescopeUploadUrl: uploadUrl,
                       dueDate: dueDate,
                       lateDate: gsLateDate,
                       points: null,
                       isUndatedHw: !dueDate,
                       isGradescope: true,
                       isSubmitted: hasActiveSubmission,
                       courseKey: courseKey,
                       courseName: course.name,
                       downloadUrl: null,
                       contentId: null,
                       canvasCourseId: null
            });
          });

          if (tasks.length > 0) {
            gsTasksByCourse[courseKey] = {
              name: course.name,
              tasks: tasks
            };
          }

          if (grades.length > 0) {
            gsGradesByCourse[courseKey] = {
              name: course.name,
              grades: grades
            };
          }
        } catch (err) {
          console.warn(`[Gradescope] Error on ${course.name}:`, err);
        }
        }
      });
      await Promise.all(gsWorkers);
    } catch (e) {
      console.warn('[Gradescope] Error:', e);
    }

    return { tasksByCourse: gsTasksByCourse, gradesByCourse: gsGradesByCourse, courseUrlsByCourse: gsCourseUrlsByKey };
  }

export async function fetchCanvasAnnouncements(headers, activeCourses, courseNameById) {
    const announcements = [];

    if (activeCourses && activeCourses.length > 0) {
// Per-course fetches instead of the global /api/v1/announcements
      // index: that single call's cross-course ordering/pagination silently
      // drops recent posts once a term fills up, which shelled out as a News
      // column stuck days old. One request per active course (newest few
      // each), merged and sorted below — deterministic and always current.
      await Promise.all((activeCourses || []).map(async (c) => {
        if (!c || !c.id) return;
        try {
          const annRes = await fetch(
            `${origin}/api/v1/courses/${c.id}/discussion_topics?only_announcements=true&order_by=recent_activity&per_page=5`,
            { credentials: 'include', headers: headers }
          );
          if (!annRes.ok) {
            console.warn('[Announcements] HTTP ' + annRes.status + ' for course ' + c.id);
            return;
          }
          const items = await annRes.json();
          if (!Array.isArray(items)) return;
          items.forEach(item => {
            const canvasCourseId = c.id;
            const rawCourseName = courseNameById[canvasCourseId];
            const courseKey = normalizeCourseCode(rawCourseName || item.context_code || '');
            const postedAt = item.posted_at ? new Date(item.posted_at)
            : (item.delayed_post_at ? new Date(item.delayed_post_at) : null);
            const plainMessage = String(item.message || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

            announcements.push({
              id: `ann_${item.id}`,
              title: item.title || 'Announcement',
              message: plainMessage,
              url: item.html_url || null,
              postedAt: (postedAt && !isNaN(postedAt.getTime())) ? postedAt : null,
                               courseKey: courseKey,
                               courseName: rawCourseName || courseKey,
                               canvasCourseId: canvasCourseId
            });
          });
        } catch (e) {
          console.warn('[Announcements] fetch error (course ' + c.id + '):', e);
        }
      }));
    }

    try {
      const unreadRes = await fetch(`${origin}/api/v1/conversations/unread_count`, {
        credentials: 'include',
        headers: headers
      });
      if (unreadRes.ok) {
        const data = await unreadRes.json();
        const count = parseInt(data && data.unread_count, 10);
        state.cachedUnreadInboxCount = isNaN(count) ? 0 : count;
      }
    } catch (e) {
      console.warn('[Inbox] unread_count fetch error:', e);
    }

    announcements.sort((a, b) => (b.postedAt ? b.postedAt.getTime() : 0) - (a.postedAt ? a.postedAt.getTime() : 0));
    return announcements;
  }

export async function fetchCanvasGrades(headers, courseNameById) {
    const grades = [];
    try {
      const submissions = await fetchAllPages(`${origin}/api/v1/users/self/graded_submissions?include[]=assignment&per_page=50`, headers, 5);
      if (!Array.isArray(submissions)) return grades;

      submissions.forEach(sub => {
        if (sub.score === null || sub.score === undefined || sub.excused) return;
        const assignment = sub.assignment;
        if (!assignment) return;

        const rawCourseName = courseNameById[assignment.course_id];
        if (!rawCourseName) return;

        const courseKey = normalizeCourseCode(rawCourseName);

        grades.push({
          id: `canvas_${sub.id}`,
          canvasAssignmentId: assignment.id,
          title: assignment.name,
          score: sub.score,
          pointsPossible: assignment.points_possible ?? null,
          url: assignment.html_url || sub.html_url || null,
          gradedAt: sub.graded_at ? new Date(sub.graded_at) : null,
                    isGradescope: false,
                    courseKey: courseKey,
                    courseName: rawCourseName
        });
      });
    } catch (e) {
      console.warn('[Grades] Canvas error:', e);
    }
    return grades;
  }
