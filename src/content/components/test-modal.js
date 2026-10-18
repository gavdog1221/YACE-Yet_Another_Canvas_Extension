import { state } from '../state.js';
import { addCustomTest } from '../storage/custom-tests.js';
import { escapeHTML } from '../utils/text.js';

// Small "New Test / Quiz" dialog for the Tests tab — for exams a prof
// announces in class that Canvas will never list. Reuses the doc-preview
// modal shell and the am-* form classes so it reads as a trimmed-down New
// Assignment dialog without duplicating any modal CSS. Date left empty = TBA
// (shows in the Tests tab's "No date set" group).
export function openTestModal(onSaved) {
    let modal = document.getElementById('yace-test-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'yace-test-modal';
      modal.className = 'doc-preview-modal assignment-modal';
      modal.innerHTML = `
      <div class="doc-preview-backdrop"></div>
      <div class="doc-preview-dialog assignment-dialog">
      <div class="doc-preview-header">
      <span class="doc-preview-title">New Test / Quiz</span>
      <button type="button" class="doc-preview-close" id="test-modal-close" title="Close">✕</button>
      </div>
      <div class="assignment-modal-body">
      <label class="am-label">What is it?</label>
      <input type="text" id="test-title" class="am-input" maxlength="120" placeholder="e.g. Quiz 3, Midterm 2, Final...">
      <label class="am-label">Course</label>
      <select id="test-course" class="am-input"></select>
      <label class="am-label">Date <span class="am-optional">(leave empty if TBA)</span></label>
      <input type="date" id="test-date" class="am-input">
      </div>
      <div class="doc-preview-header assignment-modal-footer">
      <div class="am-footer-right">
      <button type="button" class="am-btn am-btn-ghost" id="test-cancel-btn">Cancel</button>
      <button type="button" class="am-btn am-btn-primary" id="test-save-btn">Add Test</button>
      </div>
      </div>
      </div>
      `;
      document.body.appendChild(modal);

      const close = () => modal.classList.remove('is-open');
      modal.querySelector('.doc-preview-backdrop').addEventListener('click', close);
      modal.querySelector('#test-modal-close').addEventListener('click', close);
      modal.querySelector('#test-cancel-btn').addEventListener('click', close);

      modal.querySelector('#test-save-btn').addEventListener('click', () => {
        const entry = addCustomTest({
          title: modal.querySelector('#test-title').value,
          courseKey: modal.querySelector('#test-course').value,
          dateKey: modal.querySelector('#test-date').value,
        });
        if (!entry) { modal.querySelector('#test-title').focus(); return; }
        close();
        if (typeof onSaved === 'function') onSaved(entry);
      });
      // Enter submits from the title field (the date input keeps native behavior).
      modal.querySelector('#test-title').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') modal.querySelector('#test-save-btn').click();
      });
    }

    modal.setAttribute('data-theme', state.currentTheme);
    // Repopulate every open — the course map grows as scans complete.
    const select = modal.querySelector('#test-course');
    select.innerHTML = '<option value="">No course</option>' + Object.keys(state.cachedCourseMap)
      .sort()
      .map((k) => `<option value="${escapeHTML(k)}">${escapeHTML((state.cachedCourseMap[k] || {}).name || k)}</option>`)
      .join('');
    modal.querySelector('#test-title').value = '';
    modal.querySelector('#test-date').value = '';
    select.value = '';
    modal.classList.add('is-open');
    setTimeout(() => modal.querySelector('#test-title').focus(), 40);
  }
