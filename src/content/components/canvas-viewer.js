import { origin } from '../constants.js';
import { escapeHTML } from '../utils/text.js';
import { fetchAllPages, getCsrfToken } from '../services/canvas-api.js';
import { openPdfModal } from './pdf-modal.js';

// Canvas Viewer — replaces the raw "open Canvas in a new tab / iframe" handoffs
// (task pages, announcements, course home, and the Info card's Modules / Files /
// Grades previews) with custom YACE-styled panels built from the Canvas API.
// Every view keeps an "Open in Canvas ↗" escape hatch in the header. The modal
// reuses the .doc-preview-modal chrome so Esc/backdrop/keyboard-gating all
// behave like the existing document preview.

function apiHeaders() {
    return {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': getCsrfToken()
    };
  }

async function apiGet(url) {
    const res = await fetch(url, { credentials: 'include', headers: apiHeaders() });
    if (!res.ok) throw new Error('Canvas returned HTTP ' + res.status);
    return res.json();
  }

let viewerModal = null;

export function closeCanvasViewer() {
    if (viewerModal) viewerModal.classList.remove('is-open');
  }

function ensureViewerModal() {
    if (viewerModal) return viewerModal;
    const modal = document.createElement('div');
    modal.id = 'canvas-viewer-modal';
    modal.className = 'doc-preview-modal canvas-viewer-modal';
    modal.innerHTML = `
    <div class="doc-preview-backdrop"></div>
    <div class="doc-preview-dialog canvas-viewer-dialog">
    <div class="doc-preview-header">
    <span class="doc-preview-title" id="canvas-viewer-title">Canvas</span>
    <div class="doc-preview-actions">
    <a class="doc-preview-btn-top" id="canvas-viewer-open-tab" target="_blank" rel="noopener noreferrer">↗ Open in Canvas</a>
    <button type="button" class="doc-preview-close" id="canvas-viewer-close-btn" title="Close">✕</button>
    </div>
    </div>
    <div class="canvas-viewer-body" id="canvas-viewer-body"></div>
    </div>`;
    document.body.appendChild(modal);

    const close = () => closeCanvasViewer();
    modal.querySelector('.doc-preview-backdrop').addEventListener('click', close);
    modal.querySelector('#canvas-viewer-close-btn').addEventListener('click', close);
    viewerModal = modal;
    return modal;
  }

function setOpenTabHref(modal, url) {
    const el = modal.querySelector('#canvas-viewer-open-tab');
    el.setAttribute('href', url || '#');
    el.style.display = url ? '' : 'none';
  }

function setViewerTitle(modal, text) {
    modal.querySelector('#canvas-viewer-title').textContent = text || 'Canvas';
  }

function bodyEl(modal) {
    return modal.querySelector('.canvas-viewer-body');
  }

function fmtDate(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

function formatScore(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return String(parseFloat(n.toFixed(2)));
  }

function formatBytes(b) {
    if (b === null || b === undefined || isNaN(b)) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

function chipsHtml(items) {
    return items.filter(Boolean).map(i => `<span class="cv-chip">${i}</span>`).join('');
  }

// Canvas description HTML is instructor-authored content on the same origin —
// safe enough to render, but strip live-embedding elements and event handlers
// so nothing dynamic runs inside the viewer.
function sanitizeCanvasHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta, noscript, video, audio, svg').forEach(el => el.remove());
    doc.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });
    return doc.body.innerHTML;
  }

// Any anchor rendered inside the viewer must never navigate the dashboard
// itself — force new tabs so the user is only ever one click away from coming
// back.
function externalizeLinks(root) {
    root.querySelectorAll('a[href]').forEach(a => {
      if (!a.hasAttribute('target')) a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }

// Pulls /courses/:cid/files/:fid links out of description HTML — these are
// the assignment attachments. The file names need one extra request mapping
// file ids back to display names.
function extractFileLinks(html) {
    const out = [];
    const re = /href="([^"]*\/courses\/\d+\/files\/(\d+)(?:\/[^"]*)?)"/g;
    let m;
    while ((m = re.exec(html || '')) !== null) {
      const fid = m[2];
      if (!out.some(f => f.id === fid)) out.push({ id: fid, url: m[1].replace(/&amp;/g, '&') });
    }
    return out;
  }

function fileDownloadUrl(courseId, fileId) {
    return `${origin}/courses/${courseId}/files/${fileId}/download?download_frd=1`;
  }

function filePreview(courseId, fileId, title) {
    openPdfModal('', title || 'File Preview', courseId, fileId);
  }

// ---------------------------------------------------------------------------
//  Views
// ---------------------------------------------------------------------------

async function renderAssignment(modal, opts) {
    const { courseId, assignmentId, courseKey, courseName, url } = opts;
    let a;
    try {
      a = await apiGet(`${origin}/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
    } catch (err) {
      // content_id from a module item isn't always a real assignment id — bail
      // to the plain Canvas page instead of showing an error.
      if (url) window.open(url, '_blank');
      closeCanvasViewer();
      return;
    }

    let name = courseName;
    try {
      const c = await apiGet(`${origin}/api/v1/courses/${courseId}?include[]=term`);
      name = c.name || name;
    } catch (e) { /* name fallback only */ }

    const filesById = new Map();
    try {
      const files = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/files?per_page=100`, apiHeaders(), 4);
      files.forEach(f => filesById.set(String(f.id), f));
    } catch (e) { /* attachment names just fall back to ids */ }

    const due = fmtDate(a.due_at);
    const points = a.points_possible !== null && a.points_possible !== undefined ? formatScore(a.points_possible) + ' pts' : null;
    const types = (Array.isArray(a.submission_types) ? a.submission_types : [])
    .filter(t => t !== 'none')
    .map(t => t.replace(/_/g, ' '))
    .join(', ') || null;

    const sub = a.submission && a.submission.workflow_state && a.submission.workflow_state !== 'unsubmitted' ? a.submission : null;
    let statusChip = null;
    if (sub) {
      const graded = sub.workflow_state === 'graded' || (sub.score !== null && sub.score !== undefined);
      statusChip = graded
      ? `Graded · ${formatScore(sub.score)}${a.points_possible !== null && a.points_possible !== undefined ? ' / ' + formatScore(a.points_possible) : ''}`
      : 'Submitted';
    } else if (a.locked_for_user) {
      statusChip = 'Locked';
    }

    const descHtml = sanitizeCanvasHtml(a.description || '');
    const attachments = extractFileLinks(a.description || '').map(f => {
      const file = filesById.get(String(f.id));
      return { id: f.id, name: (file && (file.display_name || file.filename)) || ('attachment-' + f.id) };
    });

    setOpenTabHref(modal, a.html_url || url || null);
    setViewerTitle(modal, a.name || opts.title || 'Assignment');

    const body = bodyEl(modal);
    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(courseKey || name || '')}</span> ${escapeHTML(name || '')}</div>
    <h1 class="cv-title">${escapeHTML(a.name || opts.title || 'Assignment')}</h1>
    <div class="cv-chips">
    ${chipsHtml([due ? '🕐 ' + due : null, points ? '🏆 ' + points : null, types ? '📝 ' + types : null, statusChip ? '✅ ' + statusChip : null])}
    </div>
    ${sub && sub.submitted_at ? `<div class="cv-submission-line">Submitted ${fmtDate(sub.submitted_at) || ''}${a.points_possible !== null && a.points_possible !== undefined ? ' · Score ' + formatScore(sub.score) + ' / ' + formatScore(a.points_possible) : ''}</div>` : ''}
    ${descHtml ? `<div class="cv-description">${descHtml}</div>` : '<p class="cv-empty">No description posted on Canvas.</p>'}
    ${attachments.length ? `
      <div class="cv-section-title">📎 Attachments</div>
      <div class="cv-file-list">
      ${attachments.map(f => `
        <div class="cv-file-row">
        <span class="cv-file-icon">📄</span>
        <span class="cv-file-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span>
        <span class="cv-file-actions">
        <button type="button" class="doc-preview-btn-top cv-file-btn" data-preview-file="${escapeHTML(f.id)}">Preview</button>
        <a class="doc-preview-btn-top" href="${escapeHTML(fileDownloadUrl(courseId, f.id))}" download target="_blank" rel="noopener noreferrer">Download ⤓</a>
        </span>
        </div>`).join('')}
      </div>` : ''}
    </div>`;

    body.querySelectorAll('[data-preview-file]').forEach(btn => {
      btn.addEventListener('click', () => filePreview(courseId, btn.getAttribute('data-preview-file'), (a.name || 'File') + ' — preview'));
    });
    externalizeLinks(body);
  }

async function renderAnnouncement(modal, opts) {
    const { courseId, topicId, url } = opts;
    const t = await apiGet(`${origin}/api/v1/courses/${courseId}/discussion_topics/${topicId}`);

    setOpenTabHref(modal, t.html_url || url || null);
    setViewerTitle(modal, t.title || opts.title || 'Announcement');

    const author = (t.author && (t.author.display_name || t.author.name)) || null;
    const posted = fmtDate(t.posted_at || t.delayed_post_at);
    const commentCount = t.discussion_subentry_count || 0;
    const messageHtml = sanitizeCanvasHtml(t.message || '');

    const attachments = [];
    if (t.attachment && t.attachment.id) {
      attachments.push({ id: String(t.attachment.id), name: t.attachment.display_name || t.attachment.filename || 'attachment' });
    }
    extractFileLinks(t.message || '').forEach(f => {
      if (!attachments.some(x => x.id === f.id)) attachments.push({ id: f.id, name: 'attachment-' + f.id });
    });

    const body = bodyEl(modal);
    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(opts.courseKey || '')}</span> ${escapeHTML(opts.courseName || '')}</div>
    <h1 class="cv-title">${escapeHTML(t.title || opts.title || 'Announcement')}</h1>
    <div class="cv-chips">
    ${chipsHtml([author ? '👤 ' + author : null, posted ? '🕐 ' + posted : null, commentCount ? '💬 ' + commentCount + ' comment' + (commentCount === 1 ? '' : 's') : null])}
    </div>
    ${messageHtml ? `<div class="cv-description">${messageHtml}</div>` : '<p class="cv-empty">No message body.</p>'}
    ${attachments.length ? `
      <div class="cv-section-title">📎 Attachments</div>
      <div class="cv-file-list">
      ${attachments.map(f => `
        <div class="cv-file-row">
        <span class="cv-file-icon">📄</span>
        <span class="cv-file-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span>
        <span class="cv-file-actions">
        <button type="button" class="doc-preview-btn-top cv-file-btn" data-preview-file="${escapeHTML(f.id)}">Preview</button>
        <a class="doc-preview-btn-top" href="${escapeHTML(fileDownloadUrl(courseId, f.id))}" download target="_blank" rel="noopener noreferrer">Download ⤓</a>
        </span>
        </div>`).join('')}
      </div>` : ''}
    </div>`;

    body.querySelectorAll('[data-preview-file]').forEach(btn => {
      btn.addEventListener('click', () => filePreview(courseId, btn.getAttribute('data-preview-file'), (t.title || 'Attachment') + ' — preview'));
    });
    externalizeLinks(body);
  }

async function renderCourse(modal, opts) {
    const { courseId, courseKey, courseName, syllabusPdfUrl, url } = opts;
    const c = await apiGet(`${origin}/api/v1/courses/${courseId}?include[]=teachers&include[]=term&include[]=total_students&include[]=syllabus_body`);

    const name = c.name || courseName || courseKey;
    setOpenTabHref(modal, c.html_url || url || null);
    setViewerTitle(modal, name);

    const term = (c.term && c.term.name) || null;
    const teachers = Array.isArray(c.teachers) ? c.teachers.map(tr => tr.display_name).filter(Boolean) : [];
    const syllabusHtml = sanitizeCanvasHtml(c.syllabus_body || '');

    const body = bodyEl(modal);
    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(courseKey || c.course_code || '')}</span> ${escapeHTML(c.course_code || '')}</div>
    <h1 class="cv-title">${escapeHTML(name)}</h1>
    <div class="cv-chips">
    ${chipsHtml([term ? '🗓 ' + term : null, c.total_students != null ? '👥 ' + c.total_students + ' students' : null])}
    </div>
    ${teachers.length ? `
      <div class="cv-section-title">👩‍🏫 Instructors</div>
      <div class="cv-teacher-list">${teachers.map(t => `<span class="cv-teacher-chip">${escapeHTML(t)}</span>`).join('')}</div>` : ''}
    <div class="cv-actions-row">
    ${syllabusPdfUrl ? `<button type="button" class="doc-preview-btn-top cv-nav-btn" data-nav="syllabus">📄 Syllabus PDF</button>` : ''}
    <button type="button" class="doc-preview-btn-top cv-nav-btn" data-nav="modules">🗂 Modules</button>
    <button type="button" class="doc-preview-btn-top cv-nav-btn" data-nav="files">📁 Files</button>
    <button type="button" class="doc-preview-btn-top cv-nav-btn" data-nav="grades">📊 Grades</button>
    <button type="button" class="doc-preview-btn-top cv-nav-btn" data-nav="people">👥 People</button>
    </div>
    ${syllabusHtml ? `<div class="cv-section-title">📋 Syllabus</div><div class="cv-description">${syllabusHtml}</div>` : ''}
    </div>`;

    body.querySelectorAll('.cv-nav-btn[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nav = btn.getAttribute('data-nav');
        if (nav === 'syllabus' && syllabusPdfUrl) {
          openPdfModal(syllabusPdfUrl, name + ' — Syllabus');
        } else {
          openCanvasViewer({ kind: nav, courseId, courseKey, courseName: name, url });
        }
      });
    });
    externalizeLinks(body);
  }

const MOD_TYPE_ICON = {
    File: '📄', Assignment: '📝', Quiz: '❓', Discussion: '💬',
    Page: '📃', ExternalTool: '🔗', ExternalUrl: '🌐', SubHeader: '▸'
  };

// The Canvas file a module item points at, as { courseId, fileId }, or null if
// it isn't a course file.
//
// Deliberately keyed off the URL as well as item.type, because Canvas does not
// type a "link straight to a course PDF" item as a File — it comes through as
// an ExternalUrl whose html_url is /courses/:cid/files/:fid?wrap=1, rendering
// as a plain link that just navigates to the PDF. Gating on type alone left
// those rows with no pills at all.
//
// The course id travels WITH the file id rather than being assumed to be the
// course being viewed. A module can link a PDF that lives in another course —
// a shared handout, a re-used deck from a previous term — and those links are
// exactly as previewable as same-course ones. Dropping them because the course
// id differed is what left those rows with no pills at all; what actually breaks
// a cross-course file is building the URL from the wrong course, which is why
// callers must use ref.courseId and not the viewer's.
function moduleFileRef(item, courseId) {
    if (item.type === 'File' && item.content_id != null && item.content_id !== '') {
      return { courseId: String(courseId), fileId: String(item.content_id) };
    }
    const m = /\/courses\/(\d+)\/files\/(\d+)/.exec(item.html_url || '');
    return m ? { courseId: m[1], fileId: m[2] } : null;
  }

// Module item types whose own content can link to course files. Canvas puts no
// file id on these items at all — a lab assignment whose handout lives in its
// description has content_id = the *assignment* id — so the only way to find
// the file is to fetch the content and look inside. Types not listed here (Quiz,
// Discussion, ExternalTool, SubHeader) render as plain rows: the labs that
// prompted this only ever turned out to be Assignments.
const MODULE_EXPANDABLE = { Page: 'page', Assignment: 'assignment' };

// The slot key for an item that needs fetching to find its files — "page:601",
// "assignment:4457468" — or '' when the item needs no expansion. Deliberately
// the single source of truth for both the slot markup and the hydration queue;
// deriving them separately is how "Page only" ended up as a hardcoded pair of
// conditions that Assignment items silently fell outside of.
function moduleExpandKey(item) {
    const kind = MODULE_EXPANDABLE[item.type];
    const id = item.content_id == null ? '' : String(item.content_id);
    return kind && /^\d+$/.test(id) ? kind + ':' + id : '';
  }

// Files behind a Canvas assignment: both the ones uploaded with it and the ones
// its description links or embeds. ref.name / ref.contentType are carried
// through so an uploaded attachment can show its own filename without needing
// the course file listing to resolve.
function extractAssignmentFiles(a, courseId) {
    const out = [];
    const add = (ref) => {
      if (!/^\d+$/.test(String(ref.fileId))) return;
      const key = r => r.courseId + '/' + r.fileId;
      if (!out.some(f => key(f) === key(ref))) out.push(ref);
    };
    (Array.isArray(a && a.attachments) ? a.attachments : []).forEach(f => {
      if (!f) return;
      add({ courseId: String(courseId), fileId: String(f.id),
            name: f.display_name || f.filename || null, contentType: f.content_type || null });
    });
    extractEmbeddedFiles(a && a.description).forEach(r => add({ courseId: r.courseId, fileId: r.fileId }));
    return out;
  }

// Pulls /courses/:cid/files/:fid references out of a Canvas page body.
//
// Broader than extractFileLinks() (assignment descriptions) in two ways:
// it also matches src=, because the page editor embeds a PDF as an
// <iframe src=".../files/:fid?wrap=1"> rather than a link, and it keeps the
// course id from the path instead of filtering on it, so a page linking to a
// file in another course still resolves.
function extractEmbeddedFiles(html) {
    const out = [];
    const re = /(?:href|src)="([^"]*\/courses\/(\d+)\/files\/(\d+)[^"]*)"/g;
    let m;
    while ((m = re.exec(html || '')) !== null) {
      const ref = { courseId: m[2], fileId: m[3], url: m[1].replace(/&amp;/g, '&') };
      if (!out.some(f => f.courseId === ref.courseId && f.fileId === ref.fileId)) out.push(ref);
    }
    return out;
  }

// The 👁 / ⤓ pair — same affordance the Upcoming tab puts on Canvas-backed
// assignment cards. Used on File module rows, on ExternalUrl rows that point at
// a course PDF, and on the files discovered inside Page and Assignment rows (see
// hydrateModuleSubFiles).
//
// The download href is built from the file's own course + file id rather than
// any html_url so it hits the same /download?download_frd=1 endpoint the rest of
// the extension uses, and so the preview modal's own Download button works —
// filePreview() passes an empty url, which leaves that button dead.
function fileActionPills(ref, title, cls) {
    return `<span class="cv-module-item-actions${cls ? ' ' + cls : ''}">
    <button type="button" class="doc-view-pill" data-mcourse="${escapeHTML(ref.courseId)}" data-mfile="${escapeHTML(ref.fileId)}" title="Preview ${escapeHTML(title)}">👁</button>
    <a class="download-pill" href="${escapeHTML(fileDownloadUrl(ref.courseId, ref.fileId))}" download target="_blank" rel="noopener noreferrer" title="Download ${escapeHTML(title)}">⤓</a>
    </span>`;
  }

// Pills go on any row that moduleFileRef can resolve, whatever its type — which
// includes ExternalUrl rows that are really just links to a course PDF.
// Everything else (Assignments, Quizzes, Discussions, external links to
// non-file URLs) has no file of its own, so those rows keep the existing
// click-through behaviour (viewer for graded types, new tab otherwise) and get
// their files listed underneath instead, via hydrateModuleSubFiles — a lab
// assignment has no file on the item, only a handout inside its description.
function moduleItemActions(courseId, item) {
    const ref = moduleFileRef(item, courseId);
    if (!ref) return '';
    return fileActionPills(ref, item.title || 'File', '');
  }

// Display names / content types for course files, memoised per course id for the
// lifetime of one Modules render. A single render can legitimately touch more
// than one course — the module's own files plus any cross-course PDF a page
// links to — and Canvas file ids are globally unique, so merging the maps on
// file id is safe. A failed or short listing degrades to generic labels rather
// than losing the row.
function moduleFilesIndex(courseId, cache) {
    const key = String(courseId);
    let p = cache.get(key);
    if (!p) {
      p = fetchAllPages(`${origin}/api/v1/courses/${key}/files?per_page=100`, apiHeaders(), 4)
        .then(files => { const m = new Map(); files.forEach(f => m.set(String(f.id), f)); return m; })
        .catch(() => new Map());
      cache.set(key, p);
    }
    return p;
  }

// One expanded file found inside a Page or Assignment module item.
//
// A ref may already carry its own name/content-type — an assignment's uploaded
// attachment does — in which case the per-course files listing is never
// consulted for it, which is what keeps a four-lab module from needing four
// extra /files requests purely to label four PDFs.
function moduleSubfileHtml(ref, meta) {
    const name = (ref && ref.name) || (meta && (meta.display_name || meta.filename)) || 'Document';
    // content_type is absent when the files listing failed or ran out of pages —
    // fall back to the generic icon rather than asserting a file is a PDF.
    const contentType = (ref && ref.contentType) || (meta && meta.content_type);
    return `<div class="cv-module-subfile" data-mtitle="${escapeHTML(name)}">
    <span class="cv-module-item-icon">${mimeIcon(contentType)}</span>
    <span class="cv-module-subfile-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
    ${fileActionPills(ref, name, 'cv-module-subfile-actions')}
    </div>`;
  }

// Wires every 👁 inside root, wherever it was rendered (initial paint or the
// async page expansion). Called once per render pass, never on the same nodes
// twice — attaching a second listener would open the preview modal twice per
// click.
function wireModuleFileActions(root) {
    // The pills live inside a clickable row, so without this a click on 👁 or ⤓
    // would also bubble up and open Canvas behind the preview modal.
    root.querySelectorAll('.cv-module-item-actions').forEach(actions => {
      actions.addEventListener('click', (e) => e.stopPropagation());
    });

    root.querySelectorAll('[data-mfile]').forEach(btn => {
      btn.addEventListener('click', () => {
        // The pill carries its own course id, so a PDF that lives in a different
        // course than the one being viewed still previews.
        const courseId = btn.getAttribute('data-mcourse');
        const fileId = btn.getAttribute('data-mfile');
        const host = btn.closest('[data-mtitle]');
        const title = (host && host.getAttribute('data-mtitle')) || 'File';
        // Called with the download URL (not filePreview's empty string) so the
        // preview modal's Download button is wired to the real file.
        openPdfModal(fileDownloadUrl(courseId, fileId), title + ' — preview', courseId, fileId);
      });
    });
  }

// Resolves the PDFs behind Page and Assignment module items — the "the file is
// in the details" case, where the module item is a lab or a page and the only
// trace of the PDF is a /files/:fid href (or ?wrap=1 iframe src) inside its
// description or body. Canvas puts no file id on those items at all, so the
// content has to be fetched.
//
// A single file is promoted onto the row itself (see below); several are listed
// under it.
//
// Runs after first paint so the module list appears immediately, and guards on
// isConnected throughout so a viewer closed or re-rendered mid-flight just
// drops the results instead of writing into a detached tree.
async function hydrateModuleSubFiles(body, courseId, targets, filesCache) {
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const target = queue.shift();
        // Belt and braces: moduleExpandKey already constrains this to a known
        // kind plus digits, and the target is interpolated into a selector.
        if (!/^(page|assignment):\d+$/.test(target)) continue;
        // All matching slots, not just the first: the same item routinely sits
        // in more than one module ("Readings" in week 1 and week 2), and
        // querySelector would leave every copy but one empty.
        const slots = [...body.querySelectorAll(`.cv-module-subfiles[data-expand="${target}"]`)];
        if (!slots.some(s => s.isConnected)) continue;
        const [kind, id] = target.split(':');
        let refs = [];
        try {
          if (kind === 'assignment') {
            const a = await apiGet(`${origin}/api/v1/courses/${courseId}/assignments/${id}`);
            refs = extractAssignmentFiles(a, courseId);
          } else {
            // page_id: prefix is mandatory — /pages/7 reads "7" as a page *url*
            // first, so a course with a page whose url happens to be "7" would
            // hand back the wrong body.
            const page = await apiGet(`${origin}/api/v1/courses/${courseId}/pages/page_id:${id}`);
            refs = extractEmbeddedFiles(page && page.body);
          }
        } catch (e) {
          // Deleted content, or no read permission. Drop the slot too — left in
          // place it is an invisible leftover that reads as a permanently
          // loading row, both to the eye and to the diagnostics' count.
          slots.forEach(s => { if (s.isConnected) s.remove(); });
          continue;
        }
        // Content with no files gets nothing at all, so those rows look exactly
        // as they did before.
        if (!refs.length) {
          slots.forEach(s => { if (s.isConnected) s.remove(); });
          continue;
        }
        // Names come from each file's own course listing, so a page linking
        // into another course still gets a real name instead of "Document".
        // Skipped entirely when every ref names itself, which is the normal
        // case for assignment attachments.
        const indexes = new Map();
        const unnamed = refs.filter(r => !r.name);
        for (const cid of new Set(unnamed.map(r => r.courseId))) indexes.set(cid, await moduleFilesIndex(cid, filesCache));
        const labelFor = (r) => {
          if (r.name) return r.name;
          const meta = indexes.get(r.courseId) && indexes.get(r.courseId).get(r.fileId);
          return (meta && (meta.display_name || meta.filename)) || 'Document';
        };
        slots.forEach(slot => {
          if (!slot.isConnected) return;
          // One file is the overwhelmingly common case (a lab with one handout),
          // and a nested row for a single PDF reads as a file tree rather than a
          // module list. So a lone file gets its pills on the row itself and the
          // slot is removed entirely. Two or more still need the list: one row
          // cannot say which of three PDFs an eyeball refers to.
          const row = slot.previousElementSibling;
          if (refs.length === 1 && row && row.classList.contains('cv-module-item')
            && !row.querySelector('.cv-module-item-actions')) {
            row.insertAdjacentHTML('beforeend', fileActionPills(refs[0], labelFor(refs[0]), ''));
            slot.remove();
            wireModuleFileActions(row);
            return;
          }
          slot.innerHTML = refs.map(r =>
            moduleSubfileHtml(r, indexes.get(r.courseId) && indexes.get(r.courseId).get(r.fileId))).join('');
          wireModuleFileActions(slot);
        });
      }
    };
    // Concurrency-capped: a course with 30 page or assignment items would
    // otherwise fire 30 requests the instant Modules is opened.
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  }

async function renderModules(modal, opts) {
    const { courseId, courseName, url } = opts;
    const mods = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`, apiHeaders(), 5);

    setOpenTabHref(modal, url || null);
    setViewerTitle(modal, courseName ? courseName + ' — Modules' : 'Modules');

    const body = bodyEl(modal);
    if (!mods.length) {
      body.innerHTML = '<div class="canvas-viewer-scroll"><p class="cv-empty">This course doesn\'t have any modules.</p></div>';
      return;
    }

    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(opts.courseKey || '')}</span> ${escapeHTML(courseName || '')}</div>
    <h1 class="cv-title">🗂 Modules</h1>
    ${mods.map(mod => {
      const items = Array.isArray(mod.items) ? mod.items : [];
      return `
      <div class="cv-module">
      <div class="cv-module-header"><span class="cv-module-title">${escapeHTML(mod.name || 'Module')}</span><span class="cv-module-count">${items.length} item${items.length === 1 ? '' : 's'}</span></div>
      ${items.length ? `
        <div class="cv-module-items">
        ${items.map(item => {
          const icon = MOD_TYPE_ICON[item.type] || '📄';
          const pts = item.content_details && item.content_details.points_possible != null ? formatScore(item.content_details.points_possible) + ' pts' : null;
          const due = item.content_details && item.content_details.due_at ? fmtDate(item.content_details.due_at) : null;
          const locked = !!(item.content_details && item.content_details.locked_for_user);
          const isHeader = item.type === 'SubHeader';
          if (isHeader) return `<div class="cv-module-item cv-module-subheader">${escapeHTML(item.title || '')}</div>`;
          // Empty slot under each item whose files only exist inside its own
          // content (a Page body, an assignment's description/attachments),
          // filled in after paint by hydrateModuleSubFiles. The key is emitted
          // only for a known kind plus a numeric content_id, which is both what
          // hydrateModuleSubFiles queries on and what keeps it out of reach of
          // selector injection.
          const expand = moduleExpandKey(item);
          const sub = expand
            ? `<div class="cv-module-subfiles" data-expand="${escapeHTML(expand)}"></div>` : '';
          return `
          <div class="cv-module-item" data-mitem="${escapeHTML(item.id)}" data-mtype="${escapeHTML(item.type || '')}" data-mtitle="${escapeHTML(item.title || '')}" data-mcontent="${escapeHTML(item.content_id != null ? item.content_id : '')}" data-murl="${escapeHTML(item.html_url || '')}" ${locked ? 'data-mlocked="1"' : ''}>
          <span class="cv-module-item-icon">${icon}</span>
          <span class="cv-module-item-name">${escapeHTML(item.title || 'Unnamed item')}${locked ? ' <span class="cv-lock-badge">🔒</span>' : ''}</span>
          <span class="cv-module-item-meta">${chipsHtml([pts, due])}</span>
          ${moduleItemActions(courseId, item)}
          </div>${sub}`;
        }).join('')}
        </div>` : '<div class="cv-empty cv-module-empty">No items.</div>'}
      </div>`;
    }).join('')}
    </div>`;

    wireModuleFileActions(body);

    body.querySelectorAll('.cv-module-item[data-mitem]').forEach(row => {
      row.addEventListener('click', () => {
        const type = row.getAttribute('data-mtype');
        const contentId = row.getAttribute('data-mcontent');
        const title = row.getAttribute('data-mtitle') || 'Item';
        const ref = moduleFileRef({ type, content_id: contentId, html_url: row.getAttribute('data-murl') }, courseId);
        if (type === 'Assignment' && contentId) {
          openCanvasViewer({ kind: 'assignment', courseId, assignmentId: contentId, courseKey: opts.courseKey, courseName, title, url });
        } else if (type === 'File' && ref) {
          filePreview(ref.courseId, ref.fileId, title + ' — preview');
        } else {
          window.open(row.getAttribute('data-murl') || `${origin}/courses/${courseId}/modules/items/${row.getAttribute('data-mitem')}`, '_blank');
        }
      });
    });

    // Expand Page and Assignment items so the files inside them get pills.
    // Deduplicated (the same page or lab can sit in several modules) and fired
    // without await so the list above is already on screen.
    const targets = [...new Set(mods
      .flatMap(mod => (Array.isArray(mod.items) ? mod.items : []))
      .map(moduleExpandKey)
      .filter(Boolean))];
    if (targets.length) {
      hydrateModuleSubFiles(body, courseId, targets, new Map());
    }
  }

const MIME_ICON = {
    pdf: '📕', doc: '📘', docx: '📘', ppt: '📙', pptx: '📙', xls: '📗', xlsx: '📗',
    image: '🖼', video: '🎬', audio: '🎵', zip: '🗜', text: '📄', html: '🌐'
  };

function mimeIcon(contentType) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('pdf')) return MIME_ICON.pdf;
    if (ct.includes('word') || ct.includes('officedocument')) return MIME_ICON.doc;
    if (ct.includes('powerpoint')) return MIME_ICON.ppt;
    if (ct.includes('excel') || ct.includes('spreadsheet')) return MIME_ICON.xls;
    if (ct.startsWith('image/')) return MIME_ICON.image;
    if (ct.startsWith('video/')) return MIME_ICON.video;
    if (ct.startsWith('audio/')) return MIME_ICON.audio;
    if (ct.includes('zip') || ct.includes('compressed')) return MIME_ICON.zip;
    if (ct.startsWith('text/')) return MIME_ICON.text;
    if (ct.includes('html')) return MIME_ICON.html;
    return '📄';
  }

async function renderFiles(modal, opts) {
    const { courseId, courseName, url } = opts;
    const files = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/files?per_page=100`, apiHeaders(), 5);

    setOpenTabHref(modal, url || null);
    setViewerTitle(modal, courseName ? courseName + ' — Files' : 'Files');

    const body = bodyEl(modal);
    if (!files.length) {
      body.innerHTML = '<div class="canvas-viewer-scroll"><p class="cv-empty">No files uploaded to this course.</p></div>';
      return;
    }

    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(opts.courseKey || '')}</span> ${escapeHTML(courseName || '')}</div>
    <h1 class="cv-title">📁 Files</h1>
    <div class="cv-file-list">
    ${files.map(f => `
      <div class="cv-file-row ${f.locked ? 'cv-file-locked' : ''}">
      <span class="cv-file-icon">${mimeIcon(f.content_type)}</span>
      <span class="cv-file-name" title="${escapeHTML(f.display_name || f.filename || '')}">${escapeHTML(f.display_name || f.filename || 'file')}${f.locked ? ' 🔒' : ''}</span>
      <span class="cv-file-meta">${escapeHTML(formatBytes(f.size))}${f.updated_at && fmtDate(f.updated_at) ? ' · ' + escapeHTML(fmtDate(f.updated_at)) : ''}</span>
      <span class="cv-file-actions">
      <button type="button" class="doc-preview-btn-top cv-file-btn" data-file-id="${escapeHTML(f.id)}" data-file-name="${escapeHTML(f.display_name || f.filename || 'File')}">Preview</button>
      <a class="doc-preview-btn-top" href="${escapeHTML(fileDownloadUrl(courseId, f.id))}" download target="_blank" rel="noopener noreferrer">Download ⤓</a>
      </span>
      </div>`).join('')}
    </div>
    </div>`;

    body.querySelectorAll('[data-file-id]').forEach(btn => {
      btn.addEventListener('click', () => filePreview(courseId, btn.getAttribute('data-file-id'), btn.getAttribute('data-file-name') + ' — preview'));
    });
  }

async function renderGrades(modal, opts) {
    const { courseId, courseName, courseKey, url } = opts;
    const assigns = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/assignments?per_page=100&include[]=submission&order_by=due_at`, apiHeaders(), 5);

    setOpenTabHref(modal, url || null);
    setViewerTitle(modal, courseName ? courseName + ' — Grades' : 'Grades');

    const body = bodyEl(modal);
    if (!assigns.length) {
      body.innerHTML = '<div class="canvas-viewer-scroll"><p class="cv-empty">No graded assignments on record.</p></div>';
      return;
    }

    const graded = assigns.filter(a => a.submission && a.submission.workflow_state === 'graded'
    && a.submission.score !== null && a.submission.score !== undefined);
    const gradedTotal = graded.reduce((sum, a) => sum + (a.submission.score || 0), 0);
    const possible = assigns.reduce((sum, a) => sum + (a.points_possible || 0), 0);

    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(courseKey || '')}</span> ${escapeHTML(courseName || '')}</div>
    <h1 class="cv-title">📊 Grades</h1>
    <div class="cv-chips">
    ${chipsHtml([graded.length ? '✅ ' + graded.length + ' graded' : null, possible ? '🏆 ' + formatScore(possible) + ' pts total' : null, possible ? 'Σ ' + formatScore((gradedTotal / possible) * 100) + '% of points' : null])}
    </div>
    <div class="cv-grade-table">
    ${assigns.map(a => {
      const sub = a.submission || null;
      const points = a.points_possible !== null && a.points_possible !== undefined ? formatScore(a.points_possible) : null;
      const due = fmtDate(a.due_at);
      let scoreChip = '<span class="cv-grade-status cv-grade-missing">Not submitted</span>';
      let scoreText = null;
      if (sub && sub.workflow_state !== 'unsubmitted') {
        if (sub.workflow_state === 'graded' && sub.score !== null && sub.score !== undefined) {
          scoreText = formatScore(sub.score) + (points ? ' / ' + points : '');
          scoreChip = `<span class="cv-grade-status cv-grade-done">${scoreText}</span>`;
        } else {
          scoreChip = '<span class="cv-grade-status cv-grade-pending">Submitted</span>';
        }
      }
      return `
      <div class="cv-grade-row" data-gaid="${escapeHTML(a.id)}">
      <span class="cv-grade-title">${escapeHTML(a.name || 'Assignment')}</span>
      <span class="cv-grade-meta">${escapeHTML(due || '')}</span>
      ${scoreChip}
      </div>`;
    }).join('')}
    </div>
    </div>`;

    body.querySelectorAll('.cv-grade-row[data-gaid]').forEach(row => {
      row.addEventListener('click', () => {
        openCanvasViewer({ kind: 'assignment', courseId, assignmentId: row.getAttribute('data-gaid'), courseKey, courseName });
      });
    });
  }

const ROLE_PRIORITY = {
    TeacherEnrollment: 0, TaEnrollment: 1, DesignerEnrollment: 2,
    ObserverEnrollment: 3, StudentEnrollment: 4
  };

const ROLE_META = {
    TeacherEnrollment: { label: 'Teacher', icon: '👩‍🏫' },
    TaEnrollment: { label: 'TA', icon: '🧑‍🏫' },
    DesignerEnrollment: { label: 'Designer', icon: '🎨' },
    ObserverEnrollment: { label: 'Observer', icon: '👁' },
    StudentEnrollment: { label: 'Student', icon: '🎓' }
  };

function roleMeta(enrollType) {
    return ROLE_META[enrollType] || { label: enrollType || 'Member', icon: '👤' };
  }

// Short display for a section name: the trailing number becomes the section
// ("01", "ECE 541.01" -> "Section 1"); no number ("Lab A") keeps a trimmed
// name. Keeps chips and row meta readable instead of showing full names.
function sectionShortLabel(name) {
    const nameStr = String(name || '').trim();
    const nums = nameStr.match(/\d+/g);
    if (nums && nums.length) return 'Section ' + parseInt(nums[nums.length - 1], 10);
    return nameStr.slice(0, 16) || '';
  }

async function renderPeople(modal, opts) {
    const { courseId, courseKey, courseName } = opts;
    const users = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/users?per_page=100&include[]=enrollments`, apiHeaders(), 6);

    // Section names for the "· Section: …" meta (lecture/recitation splits).
    const sectionsById = new Map();
    try {
      const sections = await fetchAllPages(`${origin}/api/v1/courses/${courseId}/sections?per_page=100`, apiHeaders(), 3);
      sections.forEach(s => sectionsById.set(String(s.id), s.name));
    } catch (e) { /* section names just fall back to none */ }

    setOpenTabHref(modal, `${origin}/courses/${courseId}/people`);
    setViewerTitle(modal, courseName ? courseName + ' — People' : 'People');

    const body = bodyEl(modal);
    if (!users.length) {
      body.innerHTML = '<div class="canvas-viewer-scroll"><p class="cv-empty">No people found in this course.</p></div>';
      return;
    }

    // Normalize each person: keep every unique role (sorted strongest first)
    // for the role chips, remember their enrollment sections, and pick the
    // strongest role for sorting + counts.
    const people = users.map(u => {
      const enrollments = (Array.isArray(u.enrollments) ? u.enrollments : [])
      .filter(en => en.type && en.type !== 'CourseCreatorEnrollment');
      const roles = [];
      const seenRoles = new Set();
      enrollments.forEach(en => {
        const type = String(en.type);
        if (!seenRoles.has(type)) { seenRoles.add(type); roles.push(type); }
      });
      roles.sort((a, b) => (ROLE_PRIORITY[a] ?? 9) - (ROLE_PRIORITY[b] ?? 9));
      const sectionNames = enrollments
        .map(en => en.course_section_id != null ? String(en.course_section_id) : null)
        .filter(s => s && sectionsById.has(s))
        .map(s => sectionsById.get(s));
      const primarySection = sectionNames[0] || '';
      const secNum = parseInt((primarySection.match(/(\d+)/) || [])[1], 10);
      const sectionLabels = sectionNames.map(sectionShortLabel);
      return {
        id: u.id,
        name: u.sortable_name || u.name || 'Unnamed person',
        displayName: u.name || u.sortable_name || 'Unnamed person',
        avatar: u.avatar_url,
        roleType: roles[0] || 'StudentEnrollment',
        roles,
        sectionNames,
        sectionLabels,
        primarySection,
        secNum: isNaN(secNum) ? Infinity : secNum
      };
    });

    // Role filter chips (Teachers / TAs / Designers / Observers / Students),
    // each doubling as a count. Only roles actually present get a chip.
    const roleCounts = { TeacherEnrollment: 0, TaEnrollment: 0, DesignerEnrollment: 0, ObserverEnrollment: 0, StudentEnrollment: 0 };
    people.forEach(p => { if (roleCounts[p.roleType] != null) roleCounts[p.roleType]++; });
    const roleLabels = { TeacherEnrollment: 'Teachers', TaEnrollment: 'TAs', DesignerEnrollment: 'Designers', ObserverEnrollment: 'Observers', StudentEnrollment: 'Students' };
    const roleOrder = ['TeacherEnrollment', 'TaEnrollment', 'DesignerEnrollment', 'ObserverEnrollment', 'StudentEnrollment'];
    const roleChips = roleOrder.filter(r => roleCounts[r] > 0).map(r =>
      `<button type="button" class="cv-role-filter" data-role="${r}">${ROLE_META[r] ? ROLE_META[r].icon : '👤'} ${roleLabels[r]} (${roleCounts[r]})</button>`
    ).join('');

    // Section filter chips ("01", "02", "03", …): one per actual section,
    // ordered numerically the same way section-sort orders rows.
    const sectionIdx = new Map();
    const sectionList = [];
    people.forEach(p => {
      p.sectionNames.forEach(sn => { if (!sectionIdx.has(sn)) { sectionIdx.set(sn, String(sectionList.length)); sectionList.push(sn); } });
    });
    sectionList.sort((a, b) => {
      const an = parseInt((a.match(/(\d+)/) || [])[1], 10);
      const bn = parseInt((b.match(/(\d+)/) || [])[1], 10);
      if (isNaN(an) !== isNaN(bn)) return isNaN(an) ? 1 : -1;
      return (isNaN(an) || an === bn ? 0 : an - bn) || a.localeCompare(b);
    });
    sectionList.forEach((sn, i) => sectionIdx.set(sn, String(i)));
    const sectionCounts = new Array(sectionList.length).fill(0);
    people.forEach(p => {
      p.sectionNames.forEach(sn => { const ix = sectionIdx.get(sn); if (ix != null) sectionCounts[ix]++; });
    });
    // One chip per distinct label ("Section 1", "Section 2", …) so an
    // oddly-named section ("ECE 541.01") still reads as just its number.
    const seenSectionLabels = new Set();
    const sectionChips = sectionList.map((sn, i) => {
      const label = sectionShortLabel(sn);
      if (seenSectionLabels.has(label)) return '';
      seenSectionLabels.add(label);
      return `<button type="button" class="cv-role-filter cv-section-filter" data-section="${i}" title="Show people in ${escapeHTML(sn)}">📋 ${escapeHTML(label)} (${sectionCounts[i]})</button>`;
    }).join('');

    const avatarHtml = (p) => {
      // Canvas ships a stock avatar URL until the user uploads one; skip it
      // and render a monogram circle instead.
      if (p.avatar && !/\/images\/messages\/avatar|default-avatar|avatar-50\.png/i.test(p.avatar)) {
        return `<img class="cv-person-avatar" src="${escapeHTML(p.avatar)}" alt="" data-avatar>`;
      }
      return `<span class="cv-person-avatar cv-person-avatar-fallback">${escapeHTML((p.name.charAt(0) || '?').toUpperCase())}</span>`;
    };

    body.innerHTML = `
    <div class="canvas-viewer-scroll">
    <div class="cv-course-row"><span class="course-tag-chip">${escapeHTML(courseKey || '')}</span> ${escapeHTML(courseName || '')}</div>
    <h1 class="cv-title">👥 People</h1>
    <div class="cv-people-controls">
    <input type="text" class="cv-people-search" placeholder="🔍 Filter by name…" aria-label="Filter people by name">
    <div class="cv-people-role-filters">
    <button type="button" class="cv-role-filter is-active" data-role="ALL">👥 All</button>
    ${roleChips}
    </div>
    ${sectionChips ? `
    <div class="cv-people-role-filters cv-people-section-filters">
    <button type="button" class="cv-role-filter cv-section-filter is-active" data-section="ALL">🎓 All sections</button>
    ${sectionChips}
    </div>` : ''}
    <div class="cv-people-sort">
    <label class="cv-people-sort-label" for="cv-people-sort-select">Sort</label>
    <select id="cv-people-sort-select" class="cv-people-sort-select">
    <option value="section" selected>Section</option>
    <option value="role">Role</option>
    <option value="name">Name</option>
    </select>
    <span class="cv-people-count"></span>
    </div>
    </div>
    <div class="cv-person-list">
    ${people.map(p => `
      <div class="cv-person-row" data-person-name="${escapeHTML(p.name.toLowerCase())}" data-person-roles="${escapeHTML(p.roles.join(' '))}">
      ${avatarHtml(p)}
      <a class="cv-person-name" href="${escapeHTML(`${origin}/courses/${courseId}/users/${p.id}`)}" target="_blank" rel="noopener noreferrer">${escapeHTML(p.displayName)}</a>
      <span class="cv-person-meta">${escapeHTML(p.sectionLabels.join(' · '))}</span>
      <span class="cv-person-roles">${p.roles.map(r => { const m = roleMeta(r); return `<span class="cv-chip cv-person-role cv-role-${m.label.toLowerCase()}">${m.icon} ${m.label}</span>`; }).join('')}</span>
      </div>`).join('')}
    </div>
    </div>`;

    // Hide avatars that fail to load; never break the row layout.
    body.querySelectorAll('img[data-avatar]').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });

    const listEl = body.querySelector('.cv-person-list');
    const rowEls = Array.from(listEl.querySelectorAll('.cv-person-row'));
    const search = body.querySelector('.cv-people-search');
    const sortSelect = body.querySelector('.cv-people-sort-select');
    const countEl = body.querySelector('.cv-people-count');
    const activeRoles = new Set();
    const activeSections = new Set();
    const roleFilterButtons = Array.from(body.querySelectorAll('.cv-role-filter[data-role]'));
    const sectionFilterButtons = Array.from(body.querySelectorAll('.cv-section-filter[data-section]'));

    const sortMode = () => sortSelect ? sortSelect.value : 'section';

    const comparePeople = (a, b) => {
      const mode = sortMode();
      if (mode === 'section') {
        if (a.secNum !== b.secNum) return a.secNum - b.secNum;
        const bySec = a.primarySection.localeCompare(b.primarySection);
        return bySec || a.name.localeCompare(b.name);
      }
      if (mode === 'name') return a.name.localeCompare(b.name);
      return ((ROLE_PRIORITY[a.roleType] ?? 9) - (ROLE_PRIORITY[b.roleType] ?? 9)) || a.name.localeCompare(b.name);
    };

    // Re-run on search / role-filter / sort changes: matched rows get
    // re-sorted (appendChild moves existing nodes), unmatched rows are
    // hidden with the CSS class (inline display can't beat the row's
    // !important flex rule) and parked at the end.
    const applyView = () => {
      const q = search ? search.value.trim().toLowerCase() : '';
      const order = [];
      people.forEach((p, i) => {
        const matchesRole = !activeRoles.size || p.roles.some(r => activeRoles.has(r));
        const matchesSection = !activeSections.size || p.sectionNames.some(sn => activeSections.has(sectionIdx.get(sn)));
        const matchesName = !q || p.name.toLowerCase().includes(q);
        if (matchesRole && matchesSection && matchesName) order.push(i);
      });
      order.sort((x, y) => comparePeople(people[x], people[y]));
      const matched = new Set(order);
      const rest = [];
      rowEls.forEach((row, i) => { if (!matched.has(i)) rest.push(i); });
      [...order, ...rest].forEach(i => listEl.appendChild(rowEls[i]));
      rowEls.forEach((row, i) => row.classList.toggle('cv-person-hidden', !matched.has(i)));
      countEl.textContent = `${order.length} of ${people.length}`;
    };

    roleFilterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const role = btn.getAttribute('data-role');
        if (role === 'ALL') activeRoles.clear();
        else if (activeRoles.has(role)) activeRoles.delete(role);
        else activeRoles.add(role);
        roleFilterButtons.forEach(b => {
          const r = b.getAttribute('data-role');
          b.classList.toggle('is-active', r === 'ALL' ? !activeRoles.size : activeRoles.has(r));
        });
        applyView();
      });
    });

    sectionFilterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const sec = btn.getAttribute('data-section');
        if (sec === 'ALL') {
          activeSections.clear();
        } else if (activeSections.has(sec)) {
          // Clicking the already-active section clears the filter.
          activeSections.delete(sec);
        } else {
          // Single-select: pick this section, drop any other.
          activeSections.clear();
          activeSections.add(sec);
        }
        sectionFilterButtons.forEach(b => {
          const s = b.getAttribute('data-section');
          b.classList.toggle('is-active', s === 'ALL' ? !activeSections.size : activeSections.has(s));
        });
        applyView();
      });
    });

    if (search) search.addEventListener('input', applyView);
    if (sortSelect) sortSelect.addEventListener('change', applyView);

    applyView();
  }

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

export function openCanvasViewer(opts) {
    const modal = ensureViewerModal();
    const body = bodyEl(modal);
    body.innerHTML = '<div class="canvas-viewer-loading"><div class="cv-spinner"></div><p>Loading from Canvas…</p></div>';
    setViewerTitle(modal, opts.title || 'Canvas');
    setOpenTabHref(modal, opts.url || null);
    modal.classList.add('is-open');

    (async () => {
      try {
        switch (opts.kind) {
          case 'assignment': await renderAssignment(modal, opts); break;
          case 'announcement': await renderAnnouncement(modal, opts); break;
          case 'course': await renderCourse(modal, opts); break;
          case 'modules': await renderModules(modal, opts); break;
          case 'files': await renderFiles(modal, opts); break;
          case 'grades': await renderGrades(modal, opts); break;
          case 'people': await renderPeople(modal, opts); break;
          default: throw new Error('Unknown viewer kind: ' + opts.kind);
        }
      } catch (err) {
        body.innerHTML = `
        <div class="canvas-viewer-scroll">
        <div class="cv-error">
        <p>Couldn't load this from Canvas right now.</p>
        <p class="cv-error-sub">${escapeHTML(err.message || '')}</p>
        <a class="doc-preview-btn-top" href="${escapeHTML(opts.url || '#')}" target="_blank" rel="noopener noreferrer">↗ Open in Canvas</a>
        </div>
        </div>`;
        console.warn('[YACE] canvas viewer failed:', err);
      }
    })();
  }