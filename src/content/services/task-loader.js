import { state } from '../state.js';
import { origin } from '../constants.js';
import { hideReloadProgress, showReloadProgress } from '../components/reload-progress.js';
import { purgeDefaultCanvasElements, updateHiddenMenuButton } from '../components/widget-shell.js';
import { fetchAllPages, fetchCanvasAnnouncements, fetchCanvasGrades, fetchGradescopeData, getCsrfToken } from '../services/canvas-api.js';
import { loadLocalAnnouncementsCacheTime, saveCoursePercentagesCache, saveLocalAnnouncementsCache, saveLocalAnnouncementsCacheTime, saveLocalCache, saveLocalGradesCache, touchLocalCacheTime } from '../storage/caches.js';
import { getHiddenCourses } from '../storage/hidden-courses.js';
import { buildGradeSnapshot, computeGradeChanges, loadGradeSnapshot, saveGradeSnapshot } from '../storage/grade-alerts.js';
import { autoCompleteSubmittedTasks } from '../storage/completed-tasks.js';
import { mergeCustomTasksIntoCourseMap } from '../storage/custom-assignments.js';
import { applyCustomDueDates } from '../storage/custom-due-dates.js';
import { isCourseInActiveTermWindow, isCurrentSemesterCourse, localDateKey } from '../utils/dates.js';
import { extractCoreAssignmentToken, findSyllabusPdfUrl, generateTaskId, normalizeCourseCode, parseAndCleanTitle, parseGradeWeightDistributions, parseGradeWeights, parseGradeWeightsInProse, parseOfficeHours, parseSyllabusInstructors } from '../utils/text.js';
import { extractPdfText, probePdfStreams } from '../utils/pdf.js';
import { refreshAnnouncementsPanels, updateAnnouncementBadge } from '../views/announcements-view.js';
import { renderCurrentView, renderFilterPills, renderWorkloadStrip, updateProgressBar } from '../views/upcoming-view.js';
import { maybeShowWhatsNewBanner } from '../components/whats-new-banner.js';

export function deduplicateCourseMap(courseMap, allGrades = []) {
    const gradedTokensByCourse = {};
    const gradedCanvasIds = new Set();

    allGrades.forEach(g => {
      if (g.canvasAssignmentId) gradedCanvasIds.add(g.canvasAssignmentId);
      if (!gradedTokensByCourse[g.courseKey]) gradedTokensByCourse[g.courseKey] = new Set();
      const tok = extractCoreAssignmentToken(g.title, g.courseKey);
      if (tok) gradedTokensByCourse[g.courseKey].add(tok);
    });

      Object.keys(courseMap).forEach(key => {
        const course = courseMap[key];
        const uniqueTasks = [];
        const courseGradedTokens = gradedTokensByCourse[key] || new Set();

        (course.tasks || []).forEach(candidate => {
          if (candidate.canvasAssignmentId && gradedCanvasIds.has(candidate.canvasAssignmentId)) {
            return;
          }

          const candToken = extractCoreAssignmentToken(candidate.title, key);
          if (candToken && courseGradedTokens.has(candToken)) {
            return;
          }

          const candDateKey = candidate.dueDate ? localDateKey(candidate.dueDate) : null;

          const existingIdx = uniqueTasks.findIndex(existing => {
            if (candidate.canvasAssignmentId && existing.canvasAssignmentId && candidate.canvasAssignmentId === existing.canvasAssignmentId) {
              return true;
            }
            if (candidate.id === existing.id) return true;

            const existToken = extractCoreAssignmentToken(existing.title, key);
            const existDateKey = existing.dueDate ? localDateKey(existing.dueDate) : null;

            if (candToken && existToken && candToken === existToken) {
              return true;
            }

            if (candidate.gradescope && candDateKey && existDateKey && candDateKey === existDateKey) {
              return true;
            }

            return false;
          });

          if (existingIdx === -1) {
            uniqueTasks.push(candidate);
          } else {
            const target = uniqueTasks[existingIdx];
            if (target.points === null && candidate.points !== null) target.points = candidate.points;
            if (!target.downloadUrl && candidate.downloadUrl) target.downloadUrl = candidate.downloadUrl;
            if (!target.contentId && candidate.contentId) target.contentId = candidate.contentId;
            if (!target.canvasCourseId && candidate.canvasCourseId) target.canvasCourseId = candidate.canvasCourseId;
            if (!target.gradescopeUploadUrl && candidate.gradescopeUploadUrl) target.gradescopeUploadUrl = candidate.gradescopeUploadUrl;
            if (!target.isSubmitted && candidate.isSubmitted) target.isSubmitted = true;
            if (!target.dueDate && candidate.dueDate) {
              target.dueDate = candidate.dueDate;
              target.isUndatedHw = false;
            }
            if (!target.lateDate && candidate.lateDate) target.lateDate = candidate.lateDate;
            if (!target.moduleName && candidate.moduleName) target.moduleName = candidate.moduleName;
            if (candidate.isGradescope) target.isGradescope = true;

            if (/\.(pdf|docx?|zip)/i.test(target.title) && !/\.(pdf|docx?|zip)/i.test(candidate.title)) {
              // Ensure the replacement title is also stripped and cleaned
              target.title = parseAndCleanTitle(candidate.title, key).title;
              target.url = candidate.url;
            }
          }
        });

        course.tasks = uniqueTasks;
      });

      return courseMap;
  }

export function mergeGradeSources(canvasGrades, gsGrades) {
    const canvasByKey = new Map();
    canvasGrades.forEach(g => {
      const token = extractCoreAssignmentToken(g.title, g.courseKey);
      if (token) canvasByKey.set(`${g.courseKey}::${token}`, g);
    });

    const merged = [...canvasGrades];
    const usedCanvasTargets = new Set();

    gsGrades.forEach(gs => {
      const token = extractCoreAssignmentToken(gs.title, gs.courseKey);
      let match = token ? canvasByKey.get(`${gs.courseKey}::${token}`) : null;

      if (!match) {
        match = canvasGrades.find(cg =>
        cg.courseKey === gs.courseKey &&
        cg.pointsPossible === gs.pointsPossible &&
        cg.score === gs.score &&
        !usedCanvasTargets.has(cg.id)
        );
      }

      if (match) {
        match.isGradescope = true;
        if (!match.url) match.url = gs.url;
        usedCanvasTargets.add(match.id);
      } else {
        merged.push(gs);
      }
    });

    return merged;
  }

// Standalone announcements refresh — the 15-minute News staleness guard. It
// fetches its own current active-course list (one cheap call) instead of
// trusting the last scan's course map, so announcements from courses added
// since that scan show up too, and it works even before the first scan has
// populated cachedCourseMap. Runs on a timer and after page load, with no
// full rescan and no dependency on the manual ↻.
export async function refreshAnnouncementsOnly() {
    // Self-throttle against reload loops: callers run this on every page
    // load, and while the refresh is cheap it is not free — never more often
    // than once a minute.
    const lastRefresh = loadLocalAnnouncementsCacheTime();
    if (Date.now() - lastRefresh < 60 * 1000) return;
    try {
      const csrfToken = getCsrfToken();
      const headers = {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const courseNameById = {};
      const activeCourses = [];
      try {
        const courseRes = await fetch(`${origin}/api/v1/courses?enrollment_state=active&per_page=100`, {
          credentials: 'include',
          headers: headers
        });
        if (courseRes.ok) {
          const courses = await courseRes.json();
          (courses || []).forEach(c => {
            if (!c.id) return;
            activeCourses.push({ id: c.id });
            courseNameById[c.id] = c.course_code || c.name;
          });
        }
      } catch (e) {
        console.warn('[YACE] announcements refresh: course list fetch failed:', e);
      }
      if (!activeCourses.length) {
        console.info('[YACE] announcements refresh: no active courses available');
        return;
      }

      const items = await fetchCanvasAnnouncements(headers, activeCourses, courseNameById);
      if (items.length > 0) {
        state.cachedAnnouncements = items;
        saveLocalAnnouncementsCache(items);
        updateAnnouncementBadge();
        refreshAnnouncementsPanels();
        // Diagnostic: show the newest fetched items so a stale-from-source
        // result (new announcements missing from the API response) is
        // distinguishable from a display problem.
        const top = items.slice(0, 8).map(a =>
          (a.postedAt ? a.postedAt.toLocaleString() : 'NO-DATE') + ' | ' + a.courseKey + ' | ' + (a.title || '').slice(0, 50)
        );
        const nullDates = items.filter(a => !a.postedAt).length;
        console.info('[YACE] announcements refresh: ' + activeCourses.length + ' courses → ' + items.length + ' items (' + nullDates + ' missing dates)\n' + top.join('\n'));
      } else {
        // An all-empty result usually means the endpoint failed (fetchCanvas
        // swallows errors) — keep the last good set rather than wiping News.
        console.info('[YACE] announcements refresh: 0 items for ' + activeCourses.length + ' courses — keeping ' + (state.cachedAnnouncements || []).length + ' cached');
      }
      saveLocalAnnouncementsCacheTime(Date.now());
    } catch (err) {
      console.warn('[YACE] announcements refresh failed:', err);
    }
  }

export async function loadTasks(showLoadingUI = true, opts = {}) {
    // The dashboard is NEVER torn down for a scan: the first render always
    // mounts it (dock + panels), so the "⇱ All" pill and the tab pills stay
    // visible and clickable the whole time. Scan feedback shows in the reload
    // overlay (showReloadProgress) and, while no data exists yet, as an
    // in-panel "Scanning…" state (renderTaskList renders it whenever
    // state.isScanning is true). The old code wiped #module-tasks-list with a
    // bare "Scanning…" message BEFORE its try block, so an exception anywhere
    // in the setup below (or a hung endpoint) wedged the widget at that
    // message forever — no dock, no working ↻. That entire failure mode is
    // gone now: setup is inside the try, the UI stays mounted, and the catch
    // renders a RETRY-able error instead.
    state.isScanning = true;
    state.scanStartedAt = Date.now();
    const scanId = (globalThis.__yaceScanSeq = (globalThis.__yaceScanSeq || 0) + 1);
    const listContainer = document.getElementById('module-tasks-list');

    // While a first-ever scan runs (no cached data to show), put the scanning
    // state INSIDE the already-mounted Assignments panel so the dock stays.
    if (showLoadingUI && (!state.cachedCourseMap || Object.keys(state.cachedCourseMap).length === 0)) {
      const assignmentsBody = listContainer.querySelector('.fullscreen-panel.assignments-panel .fullscreen-panel-body');
      if (assignmentsBody) {
        assignmentsBody.innerHTML = '<div class="mod-empty-msg">Scanning Canvas & Gradescope...</div>';
      }
    }

    if (showLoadingUI) {
      showReloadProgress('Connecting to Canvas...', 5);
    }

    try {
      const csrfToken = getCsrfToken();
      const headers = {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      // Hidden courses are intentionally never scraped: they're filtered out
      // of the course list below, so no modules / assignments / syllabus-PDF
      // fetch, no announcements, no grades, and no Gradescope page fetch
      // happens for them — a real win when several classes are hidden.
      const hiddenCourseKeys = getHiddenCourses();

      const gradescopePromise = fetchGradescopeData(hiddenCourseKeys);

      // Pull EVERY actively-enrolled course, not just ones the student has
      // starred as a favorite — favoriting is a manual, easy-to-forget step,
      // and relying on it silently drops legitimate current courses from
      // the scan. include[]=term gets us real start/end dates so "current"
      // can be determined from actual enrollment data instead of guessing
      // from the course's name. per_page is generous (100) so no course
      // gets truncated off a large course list.
      let courses = await fetchAllPages(`${origin}/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&include[]=syllabus_body&per_page=100`, headers, 5);

      // Fallback only if that somehow comes back empty (e.g. a permissions
      // quirk) — favorites is better than nothing.
      if (!courses || courses.length === 0) {
        courses = await fetchAllPages(`${origin}/api/v1/users/self/favorites/courses?include[]=total_scores&include[]=term&include[]=syllabus_body&per_page=100`, headers, 5);
      }

      if (showLoadingUI) {
        showReloadProgress('Filtering active semester courses...', 15);
      }

      const activeCourses = (courses || []).filter(course => {
        if (!course.id || course.access_restricted_by_date) return false;
        // Real term dates take priority; only fall back to name-guessing
        // when Canvas doesn't give us term info to work with.
        const termWindowResult = isCourseInActiveTermWindow(course);
        if (termWindowResult !== null) return termWindowResult;
        const rawName = course.course_code || course.name;
        if (hiddenCourseKeys.includes(normalizeCourseCode(rawName))) return false;
        return isCurrentSemesterCourse(rawName);
      });

      console.info('[YACE] scan begin —', (courses || []).length, 'courses fetched,', activeCourses.length, 'active', hiddenCourseKeys.length ? `(${hiddenCourseKeys.length} hidden, unscraped)` : '');

      const unifiedCourseMap = {};
      const courseNameById = {};
      const officialCoursePercentages = {};
      const homeworkFolderPattern = /homework|assignment|hw\b|lab\b|problem\s*set/i;

      activeCourses.forEach(c => {
        const rawCourseName = c.course_code || c.name;
        courseNameById[c.id] = rawCourseName;
        const courseKey = normalizeCourseCode(rawCourseName);
        if (!unifiedCourseMap[courseKey]) {
          const courseBaseUrl = `${origin}/courses/${c.id}`;
          const syllabusHtml = c.syllabus_body || '';
          const syllabusText = syllabusHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          const syllabusInstructors = parseSyllabusInstructors(syllabusText);
          // Multi-distribution syllabi ("Distribution 1: ... / Distribution
          // 2: ..."): keep every breakdown as an option (the Grades-tab card
          // has a picker) and honor a choice the user made in a previous run.
          const weightDists = parseGradeWeightDistributions(syllabusText);
          const prevRes = (state.cachedCourseMap && state.cachedCourseMap[courseKey]
            && state.cachedCourseMap[courseKey].resources) || {};
          const prevChoice = (typeof prevRes.gradeWeightChoice === 'number')
            ? prevRes.gradeWeightChoice : 0;
          const inlineWeights = (weightDists && weightDists.length)
            ? weightDists[Math.min(prevChoice, weightDists.length - 1)].weights
            : parseGradeWeightsInProse(syllabusText);
          // A fresh parse can come up empty on a rescrape even though the
          // weights are static (a syllabus PDF that extracts intermittently,
          // a truncated syllabus_body, a PDF-only syllabus with an inline
          // body that is just a download link). Never wipe a breakdown we
          // already had: fall back to the previous run's weights — with its
          // option set and picker choice — until a scan actually parses fresh.
          const prevWeights = (Array.isArray(prevRes.gradeWeights) && prevRes.gradeWeights.length)
            ? prevRes.gradeWeights : null;
          const fallbackToPrevWeights = (!Array.isArray(inlineWeights) || !inlineWeights.length) && prevWeights;
          unifiedCourseMap[courseKey] = {
            name: rawCourseName,
            canvasCourseId: c.id,
            tasks: [],
            resources: {
              hasSyllabusContent: syllabusText.length > 0,
              professors: syllabusInstructors,
              professorName: syllabusInstructors[0] || '',
              syllabusPdfUrl: findSyllabusPdfUrl(syllabusHtml, origin),
              gradeWeights: (() => {
              if (!inlineWeights && syllabusText.length > 60) {
                console.warn(`[YACE] Parsed no grade weights from inline syllabus for ${rawCourseName}. Text (${syllabusText.length} chars):\n${syllabusText.slice(0, 700)}`);
              }
              return fallbackToPrevWeights ? prevWeights : inlineWeights;
            })(),
              gradeWeightOptions: (weightDists && weightDists.length > 1) ? weightDists
                : fallbackToPrevWeights && Array.isArray(prevRes.gradeWeightOptions) && prevRes.gradeWeightOptions.length > 1
                  ? prevRes.gradeWeightOptions : undefined,
              gradeWeightChoice: (weightDists && weightDists.length > 1)
                ? Math.min(prevChoice, weightDists.length - 1)
                : fallbackToPrevWeights ? (typeof prevRes.gradeWeightChoice === 'number' ? prevRes.gradeWeightChoice : 0) : 0,
              officeHours: parseOfficeHours(syllabusText),
              syllabusExcerpt: syllabusText.length > 0
                ? (syllabusText.length > 220 ? syllabusText.slice(0, 220).trim() + '…' : syllabusText)
                : '',
              syllabusUrl: `${courseBaseUrl}/assignments/syllabus`,
              modulesUrl: `${courseBaseUrl}/modules`,
              filesUrl: `${courseBaseUrl}/files`,
              gradesUrl: `${courseBaseUrl}/grades`,
              peopleUrl: `${courseBaseUrl}/people`,
              homeUrl: courseBaseUrl
            }
          };
        }

        if (Array.isArray(c.enrollments)) {
          c.enrollments.forEach(en => {
            if (en.type === 'student') {
              const pct = en.computed_current_score ?? en.computed_final_score ?? null;
              if (pct !== null && !isNaN(pct)) {
                officialCoursePercentages[courseKey] = parseFloat(pct);
              }
            }
          });
        }
      });

      const announcementsPromise = (opts.refreshAnnouncements !== false)
        ? fetchCanvasAnnouncements(headers, activeCourses, courseNameById)
        : Promise.resolve(state.cachedAnnouncements || []);

      const totalSteps = Math.max(activeCourses.length, 1);
      let stepDone = 0;

      // Scan courses concurrently (capped below). Each course writes only its
      // own slot in unifiedCourseMap, so the per-course fetch chains are
      // independent — the old serial for-of turned a multi-minute full scan
      // into ~4 concurrent lanes. Progress is driven by completed courses.
      const scanCourse = async (course) => {
        const rawCourseName = courseNameById[course.id];
        const courseKey = normalizeCourseCode(rawCourseName);
        const modulePdfCandidates = [];

        // 1. Modules Scan
        try {
          const modRes = await fetch(`${origin}/api/v1/courses/${course.id}/modules?include[]=items&per_page=50`, {
            credentials: 'include',
            headers: headers
          });

          if (modRes.ok) {
            const modules = await modRes.json();
            if (Array.isArray(modules)) {
              for (const mod of modules) {
                if (!mod.items) continue;
                const isHwFolder = homeworkFolderPattern.test(mod.name || '');

                for (const item of mod.items) {
                  const parsed = parseAndCleanTitle(item.title, courseKey);
                  let dueDate = item.content_details?.due_at ? new Date(item.content_details.due_at) : parsed.dueDate;
                  const mentionsGradescope = /grade\w*scope/i.test(item.title) || /grade\w*scope/i.test(mod.name || '');

                  let downloadUrl = null;
                  let contentId = null;
                  let syllabusPdfUrl = null;
                  if (item.type === 'File' && item.content_id) {
                    contentId = item.content_id;
                    downloadUrl = `${origin}/courses/${course.id}/files/${item.content_id}/download?download_frd=1`;
                    // For syllabus hunting prefer Canvas's own URLs: the
                    // module-item link the browser uses (302s to the file
                    // server-side) or content_details.url. The hand-built
                    // `/download?download_frd=1` fallback serves an HTML
                    // interstitial to scripted fetches.
                    syllabusPdfUrl = item.url || item.content_details?.url || downloadUrl;
                  } else if (/\.pdf$/i.test(item.title) && item.url) {
                    downloadUrl = item.url;
                    syllabusPdfUrl = item.url;
                  }

                  // Remember syllabus-ish PDFs so the instructor fallback chain
                  // can try the ones professors actually post in Modules.
                  if (syllabusPdfUrl && modulePdfCandidates.length < 6) {
                    const titleIsSyllabus = /syllabus|course\s*(info|syllabus|overview)|first\s+day|intro|policies|policy|handbook|expectations|information|breakdown|grading/i.test(item.title || '');
                    const moduleIsSyllabus = /syllabus|course\s*(info|syllabus|overview)|policies|policy|expectations|handbook|information/i.test(mod.name || '');
                    const isPlainPdf = /\.pdf(\s|$)/i.test(item.title || '');
                    if (titleIsSyllabus || moduleIsSyllabus || isPlainPdf) {
                      modulePdfCandidates.push({ url: syllabusPdfUrl, priority: (titleIsSyllabus || moduleIsSyllabus) ? 0 : 1 });
                    }
                  }

                  if (dueDate || isHwFolder) {
                    unifiedCourseMap[courseKey].tasks.push({
                      id: generateTaskId(courseKey, item.title),
                                                           canvasAssignmentId: item.content_details?.assignment_id || null,
                                                           canvasCourseId: course.id,
                                                           contentId: contentId,
                                                           title: parsed.title,
                                                           url: item.html_url || `${origin}/courses/${course.id}/modules/items/${item.id}`,
                                                           dueDate: dueDate,
                                                           moduleName: mod.name,
                                                           points: item.content_details?.points_possible ?? null,
                                                           isUndatedHw: !dueDate && isHwFolder,
                                                           gradescope: mentionsGradescope,
                                                           isGradescope: false,
                                                           isSubmitted: false,
                                                           courseKey: courseKey,
                                                           courseName: rawCourseName,
                                                           downloadUrl: downloadUrl
                    });
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn(`Modules scan error for ${rawCourseName}`, e);
        }

        // Remember syllabus-ish PDFs so the instructor fallback can try them.
        modulePdfCandidates.sort((a, b) => a.priority - b.priority);
        if (unifiedCourseMap[courseKey].resources) {
          unifiedCourseMap[courseKey].resources.modulePdfUrls = modulePdfCandidates.slice(0, 4).map(c => c.url);
        }

        // 2. Full Assignments Tab Scan with Submission Status
        try {
          const assignments = await fetchAllPages(`${origin}/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100&order_by=due_at`, headers, 5);
          if (Array.isArray(assignments)) {
              for (const a of assignments) {
                const parsed = parseAndCleanTitle(a.name, courseKey);
                const dueDate = a.due_at ? new Date(a.due_at) : parsed.dueDate;
                const isHwLike = homeworkFolderPattern.test(a.name) || (a.submission_types && !a.submission_types.includes('none'));
                const isSubmitted = !!(a.submission && (a.submission.submitted_at || a.submission.workflow_state === 'submitted'));

                if (dueDate || isHwLike) {
                  let downloadUrl = null;
                  let contentId = null;

                  // Parse embedded file links from the assignment description
                  if (a.description) {
                    // Match /files/12345/download or /files/12345
                    const fileMatch = a.description.match(/\/courses\/\d+\/files\/(\d+)(?:\/download)?/i) ||
                    a.description.match(/\/files\/(\d+)(?:\/download)?/i);
                    if (fileMatch) {
                      contentId = fileMatch[1];
                      downloadUrl = `${origin}/courses/${course.id}/files/${contentId}/download?download_frd=1`;
                    } else {
                      // Fallback match for direct PDF href links inside details/body
                      const pdfLinkMatch = a.description.match(/href="([^"]+\.pdf[^"]*)"/i);
                      if (pdfLinkMatch) {
                        downloadUrl = pdfLinkMatch[1].replace(/&amp;/g, '&');
                      }
                    }
                  }

                  unifiedCourseMap[courseKey].tasks.push({
                    id: generateTaskId(courseKey, a.name),
                                                         canvasAssignmentId: a.id || null,
                                                         canvasCourseId: course.id,
                                                         contentId: contentId,
                                                         title: parsed.title,
                                                         url: a.html_url,
                                                         dueDate: dueDate,
                                                         points: a.points_possible ?? null,
                                                         isUndatedHw: !dueDate,
                                                         gradescope: /grade\w*scope/i.test(a.description || '') || /grade\w*scope/i.test(a.name),
                                                         isGradescope: false,
                                                         isSubmitted: isSubmitted,
                                                         courseKey: courseKey,
                                                         courseName: rawCourseName,
                                                         downloadUrl: downloadUrl
                  });
                }              }
            }
        } catch (e) {
          console.warn(`Assignments scan error for ${rawCourseName}`, e);
        }

        // Instructor fallback for courses whose syllabus didn't name anyone:
        // teacher enrollments -> syllabus-tab PDF -> Modules PDF(s). No-op
        // when the inline syllabus already produced a name.
        await enrichCourseInstructor(unifiedCourseMap[courseKey], course, headers);

// Grade-weight fallback: the grading breakdown often lives only in
        // the syllabus PDF (syllabus-tab link or a Modules post) when the
        // inline body is just a download link. No-op when the inline
        // syllabus text already produced a breakdown.
        await enrichCourseGradeWeights(unifiedCourseMap[courseKey], headers, courseKey);

        stepDone++;
        if (showLoadingUI) {
          const pct = 15 + Math.round((stepDone / totalSteps) * 60);
          showReloadProgress(`Scanned ${courseKey}...`, pct);
        }
      };

      const scanQueue = [...activeCourses];
      const workers = Array.from({ length: Math.min(4, scanQueue.length) }, async () => {
        while (scanQueue.length) {
          const c = scanQueue.shift();
          try {
            await scanCourse(c);
          } catch (err) {
            console.warn(`Course scan failed for ${courseNameById[c.id] || c.id}:`, err);
          }
        }
      });
      await Promise.all(workers);

      console.info('[YACE] scan courses done — parallel course scan complete');

      if (showLoadingUI) {
        showReloadProgress('Synchronizing Gradescope...', 80);
      }

      if (opts.refreshAnnouncements !== false) {
        const newAnnouncements = await announcementsPromise;
        state.cachedAnnouncements = newAnnouncements;
        saveLocalAnnouncementsCache(newAnnouncements);
        saveLocalAnnouncementsCacheTime(Date.now());
      }
      updateAnnouncementBadge();

      const { tasksByCourse: gsCourseMap, gradesByCourse: gsGradesByCourse } = await gradescopePromise;
      // fetchGradescopeData already skips hidden courses — this guard is a
      // safety net in case hidden flags changed mid-scan.
      const hiddenSet = new Set(hiddenCourseKeys);
      Object.keys(gsCourseMap).forEach(gsKey => {
        if (hiddenSet.has(gsKey)) return;
        if (!unifiedCourseMap[gsKey]) {
          unifiedCourseMap[gsKey] = { name: gsCourseMap[gsKey].name, canvasCourseId: null, tasks: [] };
        }
        unifiedCourseMap[gsKey].tasks.push(...gsCourseMap[gsKey].tasks);
      });

      if (showLoadingUI) {
        showReloadProgress('Calculating course grades & GPAs...', 90);
      }

      // 4. Grades Consolidation
      // courseNameById only contains visible courses, so fetchCanvasGrades
      // drops submissions for hidden ones (its `if (!rawCourseName) return`
      // guard) — no hidden grades cached, planned, or alerted on.
      const canvasGrades = await fetchCanvasGrades(headers, courseNameById);
      const gsGradesFlat = [];
      Object.entries(gsGradesByCourse).forEach(([gsKey, entry]) => {
        if (hiddenSet.has(gsKey)) return;
        gsGradesFlat.push(...entry.grades);
      });

      const allGrades = mergeGradeSources(canvasGrades, gsGradesFlat).sort((a, b) => {
        if (a.gradedAt && b.gradedAt) return b.gradedAt - a.gradedAt;
        if (a.gradedAt) return -1;
        if (b.gradedAt) return 1;
        return a.title.localeCompare(b.title);
      });

      state.cachedGrades = allGrades;
      saveLocalGradesCache(allGrades);

      // Grade-change alerts: diff this scan against the last snapshot so
      // newly posted / changed grades bubble up in the Grades tab. The first
      // scan after an update just establishes a baseline.
      const gradeSnapshot = loadGradeSnapshot();
      state.gradeChangeAlerts = gradeSnapshot ? computeGradeChanges(gradeSnapshot, allGrades) : [];
      saveGradeSnapshot(buildGradeSnapshot(allGrades));

      const derivedPcts = { ...officialCoursePercentages };
      const gradeTotalsByCourse = {};
      allGrades.forEach(g => {
        if (g.score !== null && g.pointsPossible && g.pointsPossible > 0) {
          if (!gradeTotalsByCourse[g.courseKey]) {
            gradeTotalsByCourse[g.courseKey] = { earned: 0, possible: 0 };
          }
          gradeTotalsByCourse[g.courseKey].earned += g.score;
          gradeTotalsByCourse[g.courseKey].possible += g.pointsPossible;
        }
      });

      Object.entries(gradeTotalsByCourse).forEach(([cKey, data]) => {
        if (!derivedPcts[cKey] && data.possible > 0) {
          derivedPcts[cKey] = Math.round((data.earned / data.possible) * 1000) / 10;
        }
      });

      state.cachedCoursePercentages = derivedPcts;
      saveCoursePercentagesCache(derivedPcts);

      // 5. Intelligent Deduplication
      deduplicateCourseMap(unifiedCourseMap, allGrades);

      console.info('[YACE] scan grades done —', allGrades.length, 'grades');

      if (showLoadingUI) {
        showReloadProgress('Ready!', 100);
      }

      const totalScanTasks = Object.values(unifiedCourseMap).reduce((n, c) => n + (c.tasks || []).length, 0);
      console.info('[YACE] scan complete —', totalScanTasks, 'tasks across', Object.keys(unifiedCourseMap).length, 'courses');

      state.cachedCourseMap = unifiedCourseMap;
      applyCustomDueDates();
      autoCompleteSubmittedTasks(state.cachedCourseMap);
      saveLocalCache(unifiedCourseMap);
      mergeCustomTasksIntoCourseMap(state.cachedCourseMap);
      renderFilterPills();
      updateHiddenMenuButton();
      updateProgressBar();
      renderWorkloadStrip();
      // Fresh scrape data lands here — force the Grades/News/Info panels to
      // rebuild instead of being re-mounted stale from the previous render.
      state.forceDashboardRebuild = true;
      // The last-started scan owns the in-memory scanning flags.
      if (scanId === globalThis.__yaceScanSeq) {
        state.isScanning = false;
        state.scanStartedAt = 0;
      }
      try {
        renderCurrentView();
      } catch (renderErr) {
        // A post-scan render failure must never leave the "Scanning…"
        // empty-state up forever — surface the actual error visibly.
        console.error('[YACE] post-scan render failed:', renderErr);
        const list = document.getElementById('module-tasks-list');
        if (list) {
          list.innerHTML = `<div class="mod-empty-msg" style="color:#f87171; white-space:pre-wrap;">YACE loaded data but failed to render — see console.\n${String(renderErr && renderErr.message || renderErr)}</div>`;
        }
      }
      maybeShowWhatsNewBanner();
      purgeDefaultCanvasElements();

      setTimeout(hideReloadProgress, 400);
    } catch (fatalErr) {
      console.error('[YACE] scan failed:', fatalErr);
      if (scanId === globalThis.__yaceScanSeq) {
        state.isScanning = false;
        state.scanStartedAt = 0;
      }
      hideReloadProgress();
      if (listContainer && (!state.cachedCourseMap || Object.keys(state.cachedCourseMap).length === 0)) {
        // Keep the dashboard mounted and show a RETRY-able error in the
        // Assignments panel instead of wiping to a dead-end message. Guarded on
        // listContainer: this runs in the catch, so a null there would throw a
        // second error out of the handler and hide the real failure above.
        const assignmentsBody = listContainer.querySelector('.fullscreen-panel.assignments-panel .fullscreen-panel-body');
        const target = assignmentsBody || listContainer;
        target.innerHTML = `<div class="mod-empty-msg" style="color:#f87171; border-color: rgba(248, 113, 113, 0.4);">Error scanning courses.<br><button type="button" class="show-more-tasks-btn" id="yace-rescan-btn">Click to retry</button></div>`;
        const retry = target.querySelector('#yace-rescan-btn');
        if (retry) retry.addEventListener('click', () => loadTasks(true));
      }
    } finally {
      // Stamp the "a scan just ran" clock on BOTH the success and failure
      // paths. The widget's 30s poll gates its background rescan on this
      // timestamp; without the stamp a scan that throws anywhere above (grade
      // snapshot, dedup, auto-complete, a render call) would leave the clock
      // stale and the poll would relaunch a full ~50-200 request scrape every
      // 30 seconds for as long as the tab is open. saveLocalCache already
      // stamped it on success — this covers the throw path.
      touchLocalCacheTime();
    }
  }

/* ---------------------------------------------------------------------------
 * Syllabus PDF fallback chain
 *
 * Some syllabi never name the professor or break down the grade inline: the
 * syllabus tab is just a link to a PDF, or the syllabus PDF lives in Modules.
 * The same PDFs are chased for both the instructor name and the grade-weight
 * breakdown, in order of reliability, and only when the inline syllabus text
 * produced nothing:
 *   1. Canvas teacher enrollments for the course (authoritative, no parsing)
 *   2. the syllabus-tab PDF, when the syllabus body links one
 *   3. syllabus-ish PDFs collected from the Modules scan
 * ------------------------------------------------------------------------- */

async function fetchTeacherNames(canvasCourseId, headers) {
    try {
      const res = await fetch(`${origin}/api/v1/courses/${canvasCourseId}/enrollments?type[]=TeacherEnrollment&per_page=50`, {
        credentials: 'include',
        headers: headers
      });
      if (!res.ok) return [];
      const list = await res.json();
      return (Array.isArray(list) ? list : [])
        .filter(e => e.type === 'TeacherEnrollment' && e.user && e.user.name)
        .map(e => String(e.user.name).trim())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

function bytesToPrintableHead(buf, n = 40) {
    if (!buf) return '';
    const bytes = new Uint8Array(buf.slice(0, n));
    let out = '';
    for (const b of bytes) {
      out += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
    }
    return out;
  }

function looksLikePdfBytes(buf) {
    if (!buf || buf.byteLength < 5) return false;
    const head = new Uint8Array(buf.slice(0, 5));
    return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d; // %PDF-
  }

async function fetchBinaryDetailed(url, headers) {
    try {
      const res = await fetch(url, { credentials: 'include', headers: headers || undefined });
      return { status: res.status, buf: res.ok ? await res.arrayBuffer() : null };
    } catch (e) {
      return { status: 0, buf: null, err: e && e.message ? e.message.slice(0, 80) : String(e) };
    }
  }

// Canvas's verifier interstitials are tiny HTML pages — a <meta refresh> or a
// JS `location` assignment to the verifier'd file URL (or an auto-posting
// form with a hidden verifier input). Pull the target out and return it as
// an absolute URL, or null when the page isn't a redirect handshake.
function findRedirectInHtml(html, baseUrl) {
    const abs = (raw) => {
      if (!raw) return null;
      try {
        const decoded = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
        return new URL(decoded, baseUrl).href;
      } catch (e) {
        return null;
      }
    };
    const metaTags = String(html).match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metaTags) {
      if (!/http-equiv=["']?refresh["']?/i.test(tag)) continue;
      const content = tag.match(/content=(["'])([\s\S]*?)\1/i);
      if (!content) continue;
      const tail = content[2].trim().replace(/^\d+\s*;\s*/, '').trim();
      let url = tail;
      if (/^url\s*=/i.test(url)) url = url.replace(/^url\s*=\s*/i, '');
      url = url.trim().replace(/^["']/, '').replace(/["']$/, '');
      if (url) {
        const resolved = abs(url);
        if (resolved) return resolved;
      }
    }
    const assign = html.match(/(?:window|document|top)?\s*\.?\s*location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (assign) return abs(assign[1]);
    const repl = html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
    if (repl) return abs(repl[1]);
    const vf = html.match(/name=["']verifier["'][^>]*value=["']([^"']*)["']|value=["']([^"']*)["'][^>]*name=["']verifier["']/i);
    if (vf) {
      const v = (vf[1] !== undefined ? vf[1] : vf[2]) || '';
      return abs(`${baseUrl.split('?')[0]}?verifier=${encodeURIComponent(v)}&download_frd=1`);
    }
    return null;
  }

function appendVerifier(fileUrl, verifier) {
    if (!verifier) return fileUrl;
    return fileUrl + (fileUrl.indexOf('?') >= 0 ? '&' : '?') + 'verifier=' + encodeURIComponent(verifier);
  }

// Fetch a Canvas file-ish URL and chase it until real PDF bytes come back.
// Handles three response shapes:
//  - raw PDF bytes → return them
//  - Canvas file JSON metadata → follow its `url` (plus `verifier`)
//  - HTML interstitial → follow meta-refresh / JS location / verifier form
// Returns { status, buf } where buf is PDF bytes, or the last non-PDF
// response (or null when nothing came back).
async function fetchPdfBytesChasing(url, headers) {
    let cur = url;
    let status = 0;
    let lastBuf = null;
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetchBinaryDetailed(cur, headers);
      if (!res) return { status: 0, buf: null };
      status = res.status;
      if (res.err) return { status: 0, buf: null, err: res.err };
      if (looksLikePdfBytes(res.buf)) return { status, buf: res.buf };
      if (!res.buf || res.buf.byteLength === 0) return { status, buf: null };
      lastBuf = res.buf;

      const first = new Uint8Array(res.buf.slice(0, 2));
      if (first[0] === 0x7b || first[0] === 0x5b) { // '{' or '[' → JSON metadata
        let meta = null;
        try { meta = JSON.parse(new TextDecoder().decode(res.buf)); } catch (e) { meta = null; }
        const rec = (meta && meta.attachment) || meta; // wrap pages → {"attachment":{...}}
        if (rec && typeof rec.url === 'string') {
          try {
            const nextUrl = new URL(appendVerifier(rec.url, rec.verifier), cur).href;
            if (nextUrl !== cur) { cur = nextUrl; continue; }
          } catch (e) { /* fall through */ }
        }
        return { status, buf: res.buf };
      }

      const html = new TextDecoder().decode(res.buf).replace(/^\uFEFF/, '');
      if (!/<(?:html|!doctype|meta|script|form)\b/i.test(html.slice(0, 400))) {
        return { status, buf: res.buf };
      }
      const next = findRedirectInHtml(html, cur);
      if (!next || next === cur) return { status, buf: res.buf };
      cur = next;
    }
    return { status, buf: lastBuf };
  }

async function fetchFileMeta(courseId, fileId, headers) {
    // include[]=verifier mints a one-time token that authorizes a download
    // WITHOUT a session cookie — exactly what we need, since background fetches
    // can't carry a valid Canvas session. The global /api/v1/files/:id endpoint
    // honors the include (the course-scoped one often 400s / omits the field),
    // so try it first, then plain metadata, then the course-scoped variants.
    const attempts = [];
    if (fileId) {
      attempts.push(`${origin}/api/v1/files/${fileId}?include[]=verifier`);
      attempts.push(`${origin}/api/v1/files/${fileId}`);
    }
    if (courseId && fileId) {
      attempts.push(`${origin}/api/v1/courses/${courseId}/files/${fileId}?include[]=verifier`);
      attempts.push(`${origin}/api/v1/courses/${courseId}/files/${fileId}`);
    }
    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt, { credentials: 'include', headers: headers });
        if (res.ok) return await res.json();
      } catch (e) { /* try the next variant */ }
    }
    return { error: 'no file metadata' };
  }

// Canvas file downloads redirect to a cross-origin CDN that content-script
// fetch() can't follow (CORS), even with credentials. The background page has
// host permissions for the CDN, so it chases URLs to PDF bytes (same
// JSON/HTML/raw-byte logic as fetchPdfBytesChasing) and returns them base64.
async function fetchPdfBytesViaBackground(urls, headers, previewAt) {
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'FETCH_FILE',
        urls: urls,
        headers: headers || undefined,
        previewAt: previewAt || 0
      }).catch(() => null);
      if (resp && resp.success && resp.bytesBase64) {
        try {
          const bin = atob(resp.bytesBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        } catch (e) {
          return null;
        }
      }
      if (resp && resp.results) {
        const detail = resp.results.map((r) =>
          `${r.url} → ${r.status}${r.err ? ' err=' + r.err : ''}${r.final ? ' final=' + r.final : ''} "${r.head || ''}"`).join(' | ');
        console.warn(`[YACE] Background PDF fetch failed — ${detail}${resp.cookies ? ' | cookies=' + resp.cookies : ' | cookies=none'}${resp && resp.capBytes !== undefined ? ' | capBytes=' + (resp.capBytes < 0 ? 'none' : resp.capBytes + 'B') : ''}`);
      }
      return null;
    } catch (e) {
      return null;
    }
  }

// Canvas file URLs often answer a scripted fetch() with something other than
// raw bytes — an HTML interstitial (wrap preview / verifier handshake) or the
// file's own JSON metadata. A browser tab sails through automatically; fetch()
// can't, so we chase: try candidate URLs, follow JSON `url` fields and HTML
// redirect handshakes, then resolve the file id through the Files API
// (include[]=verifier yields the one-time token that unlocks the raw bytes).
// Returns PDF bytes or null.
async function fetchCanvasPdfBytes(url, headers) {
    const notes = [];
    const candidates = [];
    if (url) candidates.push(url);

    // Recover the underlying Canvas file id from whatever URL shape we got:
    // course file, API file, or module item.
    let courseId = null;
    let fileId = null;
    const mFile = url && url.match(/\/courses\/(\d+)\/files\/(\d+)/i);
    if (mFile) {
      courseId = mFile[1];
      fileId = mFile[2];
      // wrap=1 preview pages never serve bytes — also try the course download URL.
      const alt = `${origin}/courses/${courseId}/files/${fileId}/download?download_frd=1`;
      if (!candidates.includes(alt)) candidates.push(alt);
    } else {
      const mApi = url && url.match(/\/api\/v1\/courses\/(\d+)\/files\/(\d+)/i);
      if (mApi) {
        courseId = mApi[1];
        fileId = mApi[2];
      } else {
        const mItem = url && url.match(/\/courses\/(\d+)\/modules\/items\/(\d+)/i);
        if (mItem) {
          try {
            const itRes = await fetch(`${origin}/api/v1/courses/${mItem[1]}/modules/items/${mItem[2]}`, {
              credentials: 'include',
              headers: headers
            });
            if (itRes.ok) {
              const item = await itRes.json();
              if (item && item.content_id) {
                courseId = mItem[1];
                fileId = item.content_id;
              }
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    for (const candidate of candidates) {
      const got = await fetchPdfBytesChasing(candidate, headers);
      if (looksLikePdfBytes(got.buf)) return got.buf;
      notes.push(`${candidate} → ${got.status}${got.err ? ' err=' + got.err : ''} "${bytesToPrintableHead(got.buf, 140)}"`);
    }

    let meta = null;
    let verifierUrl = null;
    if (courseId && fileId) {
      meta = await fetchFileMeta(courseId, fileId, headers);
      if (meta && !meta.error && typeof meta.url === 'string') {
        notes.push(`api.url=${meta.url} verifier=${meta.verifier ? 'yes' : 'no'}`);
        const got = await fetchPdfBytesChasing(appendVerifier(meta.url, meta.verifier), headers);
        if (looksLikePdfBytes(got.buf)) return got.buf;
        notes.push(`apiTarget → ${got.status}${got.err ? ' err=' + got.err : ''} "${bytesToPrintableHead(got.buf, 140)}"`);
        if (meta.verifier && fileId) {
          // Canonical verifier URL: the one-time token authorizes the download
          // instead of a session cookie — sidesteps the whole auth battle.
          verifierUrl = `${origin}/files/${fileId}/download?download_frd=1&verifier=${encodeURIComponent(meta.verifier)}`;
          const gotV = await fetchPdfBytesChasing(verifierUrl, headers);
          if (looksLikePdfBytes(gotV.buf)) return gotV.buf;
          notes.push(`verifierUrl → ${gotV.status}${gotV.err ? ' err=' + gotV.err : ''} "${bytesToPrintableHead(gotV.buf, 140)}"`);
        }
      } else {
        notes.push(`api.${meta && meta.error ? meta.error : 'no-url'}`);
      }
    }

    // Background fallback: content-script fetch() can't follow Canvas's
    // cross-origin CDN redirects (CORS), but the background page — with its
    // host permissions — can; it chases the same URL set and returns base64.
    // The canonical verifier URL leads (it's the most likely to yield bytes).
    const bgUrls = [];
    if (verifierUrl) bgUrls.push(verifierUrl);
    bgUrls.push(...candidates);
    if (meta && typeof meta.url === 'string') bgUrls.push(appendVerifier(meta.url, meta.verifier));

    // Kick the REAL token-minting hop off from page context. A no-cors fetch
    // follows Canvas's cross-origin redirect (a cors fetch aborts at the
    // boundary in Firefox), so Canvas mints a fresh single-use CDN token. Our
    // background cancels that CDN hop BEFORE it is transmitted and then fetches
    // the untouched token URL itself — the one GET that can actually read the
    // bytes. The ?yace=1 marker tells the background this hop is ours, so real
    // downloads in other tabs are never cancelled.
    const previewAt = Date.now();
    const triggerUrl = verifierUrl
        || (meta && typeof meta.url === 'string' ? appendVerifier(meta.url, meta.verifier) : null)
        || (candidates[0] || url);
    if (triggerUrl) {
        try {
            const marked = triggerUrl + (triggerUrl.indexOf('?') >= 0 ? '&' : '?') + 'yace=1';
            await fetch(marked, { mode: 'no-cors', credentials: 'include' });
        } catch (e) { /* cancelled hop is expected; harmless */ }
    }
    const bgBuf = await fetchPdfBytesViaBackground(bgUrls, headers, previewAt);
    if (looksLikePdfBytes(bgBuf)) return bgBuf;

    console.warn(`[YACE] No PDF bytes — ${notes.join(' | ')} | input=${url}`);
    return null;
  }

async function fetchPdfText(url, headers) {
    const buf = await fetchCanvasPdfBytes(url, headers);
    if (!buf) return '';
    const text = await extractPdfText(buf);
    if (!text && buf.byteLength > 0) {
      const probe = await probePdfStreams(buf);
      console.warn(`[YACE] Syllabus PDF yielded no text — size=${buf.byteLength} head="${bytesToPrintableHead(buf)}" streams=${JSON.stringify(probe)} url=${url}`);
    }
    return text;
  }

async function fetchPdfInstructorNames(url, headers) {
    return parseSyllabusInstructors(await fetchPdfText(url, headers));
  }

function setCourseProfessors(res, names) {
    const clean = (names || []).filter(Boolean);
    if (!clean.length) return;
    res.professors = clean;
    res.professorName = clean[0];
  }

// Grade-weight backfill from the syllabus PDFs. Called for every course so a
// breakdown that only exists in a PDF (syllabus-tab link or Modules post)
// still feeds the Grades tab / What-If simulator. Inline-text weights win —
// they're the authoritative body text, while PDF reconstruction is chunkier.
async function enrichCourseGradeWeights(courseEntry, headers, courseKey) {
    const res = (courseEntry && courseEntry.resources) || {};
    if (Array.isArray(res.gradeWeights) && res.gradeWeights.length) return;

    const urls = [];
    if (res.syllabusPdfUrl) urls.push(res.syllabusPdfUrl);
    (Array.isArray(res.modulePdfUrls) ? res.modulePdfUrls : []).forEach(u => {
      if (!urls.includes(u)) urls.push(u);
    });

    // PDF-only course: honor a distribution the user picked from a previous
    // run (inline mapping always resets choice for these, since it sees no
    // inline breakdown to compare against).
    const prevRes = courseKey && state.cachedCourseMap && state.cachedCourseMap[courseKey]
      ? (state.cachedCourseMap[courseKey].resources || {}) : {};
    const prevChoice = (typeof prevRes.gradeWeightChoice === 'number')
      ? prevRes.gradeWeightChoice : 0;

    for (const url of urls) {
      const text = await fetchPdfText(url, headers);
      const dists = text ? parseGradeWeightDistributions(text) : null;
      const weights = (dists && dists.length)
        ? dists[Math.min(prevChoice, dists.length - 1)].weights
        : (text ? parseGradeWeights(text) : null);
      if (weights) {
        res.gradeWeights = weights;
        res.gradeWeightOptions = (dists && dists.length > 1) ? dists : undefined;
        res.gradeWeightChoice = (dists && dists.length > 1)
          ? Math.min(prevChoice, dists.length - 1) : 0;
        console.info(`[YACE] Syllabus grade weights from PDF for ${courseEntry.name || 'course'}:`, weights);
        return;
      }
      if (text) {
        console.warn(`[YACE] Parsed no grade weights from PDF for ${courseEntry.name || 'course'}. Extracted text (${text.length} chars):\n${text.slice(0, 600)}`);
      } else {
        console.warn(`[YACE] Empty text extracted from syllabus PDF for ${courseEntry.name || 'course'}:`, url);
      }
    }
    // Static weights must survive a rescrape where the PDF fetch/extract
    // hiccups (flaky multi-hop fetch, scanned files, rate limits): keep the
    // previous run's breakdown — with its option set and picker choice —
    // rather than persisting an empty gradeWeights over known values.
    if (!res.gradeWeights && Array.isArray(prevRes.gradeWeights) && prevRes.gradeWeights.length) {
      res.gradeWeights = prevRes.gradeWeights;
      res.gradeWeightOptions = (Array.isArray(prevRes.gradeWeightOptions) && prevRes.gradeWeightOptions.length > 1)
        ? prevRes.gradeWeightOptions : undefined;
      res.gradeWeightChoice = (typeof prevRes.gradeWeightChoice === 'number') ? prevRes.gradeWeightChoice : 0;
      console.info(`[YACE] Rescrape kept previous grade weights for ${courseEntry.name || 'course'} (none parsed from PDFs this run)`);
      return;
    }
    if (urls.length) {
      console.warn(`[YACE] No grade weights from any syllabus PDF for ${courseEntry.name || 'course'} — searched:`, urls);
    }
  }

async function enrichCourseInstructor(courseEntry, canvasCourse, headers) {
    const res = (courseEntry && courseEntry.resources) || {};
    if (Array.isArray(res.professors) && res.professors.length) return;

    // 1. Canvas teacher enrollments — authoritative.
    if (canvasCourse && canvasCourse.id) {
      const teachers = await fetchTeacherNames(canvasCourse.id, headers);
      if (teachers.length) {
        setCourseProfessors(res, teachers);
        return;
      }
    }

    // 2. Syllabus-tab PDF.
    if (res.syllabusPdfUrl) {
      const names = await fetchPdfInstructorNames(res.syllabusPdfUrl, headers);
      if (names.length) {
        setCourseProfessors(res, names);
        return;
      }
    }

    // 3. Syllabus-ish PDFs posted in Modules.
    const moduleUrls = Array.isArray(res.modulePdfUrls) ? res.modulePdfUrls : [];
    for (const url of moduleUrls) {
      const names = await fetchPdfInstructorNames(url, headers);
      if (names.length) {
        setCourseProfessors(res, names);
        return;
      }
    }
  }
