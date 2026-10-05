import { state } from '../state.js';
import { getCourseColors } from '../utils/colors.js';
import { escapeHTML } from '../utils/text.js';
import { gradeTierClass, formatScoreNum, computeCoursePercentagesWithWhatIf } from '../utils/grades.js';
import { openPdfModal } from '../components/pdf-modal.js';
import { openCanvasViewer } from '../components/canvas-viewer.js';
import { applyCourseFilter } from '../views/upcoming-view.js';

export function renderGeneralView(listContainer, hiddenCourses) {
  listContainer.innerHTML = '';

  let courseKeys = Object.keys(state.cachedCourseMap).filter(k => !hiddenCourses.includes(k));

  if (state.activeCourseFilter !== 'ALL') {
    courseKeys = courseKeys.filter(k => k === state.activeCourseFilter);
  }
  if (state.searchQuery) {
    courseKeys = courseKeys.filter(k => {
      const c = state.cachedCourseMap[k];
      return k.toLowerCase().includes(state.searchQuery) || (c.name || '').toLowerCase().includes(state.searchQuery);
    });
  }

  // Only courses we actually have a Canvas id (and therefore real
  // resource links) for — custom/manual tasks-only "courses" don't apply.
  courseKeys = courseKeys.filter(k => state.cachedCourseMap[k] && state.cachedCourseMap[k].canvasCourseId);
  courseKeys.sort((a, b) => (state.cachedCourseMap[a].name || a).localeCompare(state.cachedCourseMap[b].name || b));

  if (courseKeys.length === 0) {
    listContainer.innerHTML = state.searchQuery
    ? `<div class="mod-empty-msg">No classes match "${escapeHTML(state.searchQuery)}"</div>`
    : '<div class="mod-empty-msg">📚 No active classes found this term.</div>';
    return;
  }

  const gradePercents = computeCoursePercentagesWithWhatIf(hiddenCourses);

  // "Office hours today" strip: aggregates every course whose parsed syllabus
  // office hours include the current weekday (getDay(): 0 = Sunday).
  const todayDay = new Date().getDay();
  const todayBlocks = [];
  courseKeys.forEach(key => {
    const res = state.cachedCourseMap[key].resources || {};
    const oh = Array.isArray(res.officeHours) ? res.officeHours : [];
    oh.forEach(b => {
      if (Array.isArray(b.dayIndexes) && b.dayIndexes.includes(todayDay)) {
        todayBlocks.push({ key, name: state.cachedCourseMap[key].name, display: b.display });
      }
    });
  });
  if (todayBlocks.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'gci-today-strip';
    strip.innerHTML = `
    <span class="gci-today-title">🕐 Office hours today</span>
    <div class="gci-today-items">
    ${todayBlocks.map(b => `<span class="gci-today-item"><b>${escapeHTML(b.key)}</b> — ${escapeHTML(b.display)}</span>`).join('')}
    </div>`;
    listContainer.appendChild(strip);
  }

  courseKeys.forEach(key => {
    const course = state.cachedCourseMap[key];
    const res = course.resources || {};
    const coursePalette = getCourseColors(key, course.canvasCourseId);

    const pct = gradePercents[key];
    const tier = gradeTierClass(pct);

    const card = document.createElement('div');
    card.className = `mod-task-card general-resource-card ${tier}`;
    card.style.setProperty('--task-course-accent', coursePalette.accent);
    card.style.setProperty('--task-course-glow', coursePalette.glow);
    card.style.setProperty('--task-course-soft', coursePalette.soft);

    const syllabusTitle = res.hasSyllabusContent ? 'Open full syllabus' : 'Syllabus looks empty on Canvas, but check anyway';

    // Optional per-course extra from the parsed syllabus: the office-hours line.
    // The grade-weight breakdown deliberately does NOT appear here — the Grades
    // panel already shows it (with the distribution picker) on each course's
    // summary card, and repeating it twice made this panel read like a grade
    // report instead of the links-and-hours list it is meant to be.
    const officeHoursLine = Array.isArray(res.officeHours) && res.officeHours.length > 0
    ? res.officeHours.map(b => b.display).join(' · ')
    : '';

    card.innerHTML = `
      <div class="task-body">
        <div class="task-title-row">
          <span class="course-tag-chip">${escapeHTML(key)}</span>
          <a class="mod-task-title general-course-name" href="${res.homeUrl || '#'}" target="_blank" rel="noopener noreferrer" data-canvas-open="course" title="Open ${escapeHTML(course.name || key)} on Canvas">${escapeHTML(course.name || key)}</a>
          <span class="gci-badge ${tier}">${pct !== null ? formatScoreNum(pct) + '%' : 'No grade'}</span>
        </div>

        <div class="resource-links-row">
          <button type="button" class="resource-link-pill gci-open-btn ${res.hasSyllabusContent ? '' : 'is-empty'}" data-preview-url="${escapeHTML(res.syllabusPdfUrl || res.syllabusUrl || '')}" data-preview-title="Syllabus" title="${escapeHTML(syllabusTitle)}">📄 Syllabus</button>
          <button type="button" class="resource-link-pill gci-open-btn" data-preview-url="${escapeHTML(res.modulesUrl || '')}" data-preview-title="Modules" title="Preview the Modules page">🗂 Modules</button>
          <button type="button" class="resource-link-pill gci-open-btn" data-preview-url="${escapeHTML(res.gradesUrl || '')}" data-preview-title="Grades" title="Preview the Grades page">📊 Grades</button>
          <button type="button" class="resource-link-pill gci-open-btn" data-preview-url="${escapeHTML(res.peopleUrl || '')}" data-preview-title="People" title="Preview the class roster">👥 People</button>
          <button type="button" class="resource-link-pill gci-open-btn" data-preview-url="${escapeHTML(res.homeUrl || '')}" data-preview-title="Home" title="Preview the course home page">🏠 Home</button>
        </div>

        ${officeHoursLine ? `<div class="gci-office-hours">🕐 ${escapeHTML(officeHoursLine)}</div>` : ''}
      </div>
      `;

    listContainer.appendChild(card);

    // Clicking the course chip applies the course filter to the whole
    // dashboard (clicking the already-filtered class clears it).
    const chip = card.querySelector('.course-tag-chip');
    if (chip) {
      chip.title = state.activeCourseFilter === key
      ? 'Showing only this class — click to clear'
      : 'Show only this class';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        applyCourseFilter(key);
      });
    }

    // Course name opens the in-app YACE course viewer instead of a new tab.
    const courseNameLink = card.querySelector('.general-course-name[data-canvas-open]');
    if (courseNameLink && course.canvasCourseId) {
      courseNameLink.addEventListener('click', (e) => {
        e.preventDefault();
        openCanvasViewer({
          kind: 'course',
          courseId: course.canvasCourseId,
          courseKey: key,
          courseName: course.name,
          syllabusPdfUrl: res.syllabusPdfUrl || null,
          url: res.homeUrl
        });
      });
    }

    // Resource buttons: PDFs (syllabus) keep the in-app document preview;
    // Modules / Grades / People / Home now render as custom YACE views built
    // from the Canvas API instead of the raw Canvas page. There is no Files
    // pill — the course viewer's own nav bar has one, and a second link to the
    // same page from the same card was just one more thing to scan past.
    if (course.canvasCourseId) {
      card.querySelectorAll('.gci-open-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const url = btn.getAttribute('data-preview-url');
          const previewTitle = btn.getAttribute('data-preview-title') || '';
          if (!url || url === '#') return;
          if (previewTitle === 'Syllabus') {
            if (/\.pdf(?:$|[?#])/i.test(url)) {
              openPdfModal(url, `${previewTitle} — ${course.name || key}`);
            } else {
              // Web-course syllabus page (not a PDF) — show it through the
              // course viewer, which renders the syllabus body in-app.
              openCanvasViewer({
                kind: 'course',
                courseId: course.canvasCourseId,
                courseKey: key,
                courseName: course.name,
                syllabusPdfUrl: res.syllabusPdfUrl || null,
                url
              });
            }
          } else if (previewTitle === 'Modules' || previewTitle === 'Files' || previewTitle === 'Grades' || previewTitle === 'People') {
            openCanvasViewer({
              kind: previewTitle.toLowerCase(),
              courseId: course.canvasCourseId,
              courseKey: key,
              courseName: course.name,
              url
            });
          } else {
            openCanvasViewer({
              kind: 'course',
              courseId: course.canvasCourseId,
              courseKey: key,
              courseName: course.name,
              syllabusPdfUrl: res.syllabusPdfUrl || null,
              url
            });
          }
        });
      });
    }
  });
}
