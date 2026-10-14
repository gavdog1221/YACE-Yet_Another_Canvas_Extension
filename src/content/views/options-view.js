import { state } from '../state.js';
import { THEMES } from '../constants.js';
import {
  TAB_LABELS,
  OPTION_TAB_KEYS,
  NOTIF_OPTIONS,
  applyOptions,
  applyThemeFromOptions,
  getOptions,
  saveOptions,
} from '../options.js';
import { refreshCampusToolsPalette } from '../components/campus-tools-modal.js';
import { getCourseColors, normalizeColorToHex } from '../utils/colors.js';
import { escapeHTML } from '../utils/text.js';
import { renderCurrentView, renderFilterPills } from './upcoming-view.js';

// Shared by the Class Colors controls so a toggle/pick repaints every panel
// (task cards, grades, news, info + the filter dots) immediately.
function applyColorOptions() {
    state.forceDashboardRebuild = true;
    renderFilterPills();
    renderCurrentView();
  }

// Campus & Tools "Options" tab — theme picker (same storage key + DOM targets
// as the header theme dock), which view tabs are visible, and which badge
// notifications are shown. All of it persists to STORAGE_KEY_OPTIONS via
// options.js and applies instantly through applyOptions().

export function renderOptionsView(container) {
    if (!container) return;
    const opts = getOptions();
    // Only the assignment-universe tabs stay toggleable here. Grades / Info /
    // News are modular draggable tiles with their own visibility controls in
    // the main UI — exposing them in Options conflicts with that.
    const tabKeys = OPTION_TAB_KEYS.filter(k => TAB_LABELS[k] !== undefined);

    // Per-course color rows for the Class Colors section — one per course in
    // the last loaded course map, so every class is reachable even when it has
    // no assignments in the visible window yet.
    const courses = Object.keys(state.cachedCourseMap || {}).sort();
    const hasOptedIn = !!opts.colorCourses;
    const courseRows = courses.map(key => {
      const course = state.cachedCourseMap[key] || {};
      const palette = getCourseColors(key, course.canvasCourseId);
      const override = opts.courseColors[key];
      const currentHex = normalizeColorToHex(override || palette.accent) || '#ffffff';
      return `
      <div class="opt-course-color-row">
      <span class="cf-dot" style="background:${escapeHTML(palette.accent)}"></span>
      <span class="opt-course-color-name" title="${escapeHTML(course.name || key)}">${escapeHTML(key)}</span>
      <input type="color" data-course-key="${escapeHTML(key)}" value="${escapeHTML(currentHex)}" ${hasOptedIn ? '' : 'disabled'}>
      <button type="button" class="opt-course-color-reset" data-reset-key="${escapeHTML(key)}" title="Reset to auto color" ${hasOptedIn && override ? '' : 'disabled'}>↺</button>
      </div>`;
    }).join('');

    container.innerHTML = `
    <div class="opt-view-header">
    <span class="opt-title">⚙️ Options</span>
    <span class="opt-sub">Customize the dashboard — these settings are saved to this browser.</span>
    </div>
    <div class="opt-tab-scroll">
    <section class="opt-section">
    <h3 class="opt-section-title">🎨 Theme</h3>
    <div class="opt-theme-row">
    ${THEMES.map(t => `
      <button type="button" class="opt-theme-btn ${state.currentTheme === t.id ? 'active' : ''}" data-theme="${escapeHTML(t.id)}" title="${escapeHTML(t.label)}" aria-pressed="${state.currentTheme === t.id}">
      <span class="opt-theme-swatch" style="--gem-color: ${escapeHTML(t.color)};"></span>
      <span class="opt-theme-name">${escapeHTML(t.label)}</span>
      </button>`).join('')}
    </div>
    </section>

    <section class="opt-section">
    <h3 class="opt-section-title">🌈 Class Colors</h3>
    <p class="opt-hint">Give every course its own accent color across cards, grades, news and filters. Off keeps today's monochrome look; on, classes auto-color from your Canvas dashboard cards (with a fallback palette) until you pick one yourself.</p>
    <div class="opt-toggles">
    <label class="opt-toggle">
    <input type="checkbox" data-opt="colorcourses" ${opts.colorCourses ? 'checked' : ''}>
    <span>Color-code classes</span>
    </label>
    </div>
    <div class="opt-course-colors ${opts.colorCourses ? '' : 'is-inactive'}">
    ${courses.length ? courseRows : '<p class="opt-hint">Your courses appear here once assignments have loaded.</p>'}
    </div>
    </section>

    <section class="opt-section">
    <h3 class="opt-section-title">🗂 View tabs</h3>
    <p class="opt-hint">Choose which tabs appear in the dashboard's view bar. If the last visible tab is hidden, a fallback keeps your assignments reachable.</p>
    <div class="opt-toggles">
    ${tabKeys.map(key => `
      <label class="opt-toggle">
      <input type="checkbox" data-opt="tab" data-key="${key}" ${opts.hiddenTabs.indexOf(key) === -1 ? 'checked' : ''}>
      <span>${escapeHTML(TAB_LABELS[key])}</span>
      </label>`).join('')}
    </div>
    </section>

    <section class="opt-section">
    <h3 class="opt-section-title">🔔 Notifications</h3>
    <div class="opt-toggles">
    ${NOTIF_OPTIONS.map(n => `
      <label class="opt-toggle">
      <input type="checkbox" data-opt="notif" data-key="${n.key}" ${opts.notif[n.key] === false ? '' : 'checked'}>
      <span>${escapeHTML(n.label)}</span>
      </label>`).join('')}
    </div>
    </section>
    </div>
    `;

    container.querySelectorAll('.opt-theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const themeId = btn.getAttribute('data-theme');
        if (!themeId) return;
        applyThemeFromOptions(themeId);
        refreshCampusToolsPalette();
        container.querySelectorAll('.opt-theme-btn').forEach(b => {
          const on = b.getAttribute('data-theme') === themeId;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
      });
    });

    container.querySelectorAll('input[data-opt="tab"]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-key');
        const optsNow = getOptions();
        let hidden = optsNow.hiddenTabs.slice();
        if (input.checked) {
          hidden = hidden.filter(k => k !== key);
        } else {
          // Never hide the last remaining tab — the dashboard needs at least
          // one view to land on.
          const visible = tabKeys.filter(k => hidden.indexOf(k) === -1);
          if (visible.length <= 1 && visible.indexOf(key) !== -1) {
            input.checked = true;
            return;
          }
          hidden.push(key);
        }
        saveOptions({ hiddenTabs: hidden });
        applyOptions();
      });
    });

    container.querySelectorAll('input[data-opt="notif"]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-key');
        const notif = Object.assign({}, getOptions().notif);
        notif[key] = input.checked;
        saveOptions({ notif });
        applyOptions();
      });
    });

    container.querySelectorAll('input[data-opt="colorcourses"]').forEach(input => {
      input.addEventListener('change', () => {
        saveOptions({ colorCourses: input.checked });
        applyColorOptions();
        // Rebuild the section so the per-course controls enable/disable
        // together with the master toggle.
        renderOptionsView(container);
      });
    });

    container.querySelectorAll('input[data-course-key]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-course-key');
        if (!key) return;
        const courseColors = Object.assign({}, getOptions().courseColors);
        courseColors[key] = input.value;
        saveOptions({ courseColors });
        applyColorOptions();
        // Paint this row's swatch + reset button in place instead of
        // re-rendering the section, so the scroll position survives.
        const row = input.closest('.opt-course-color-row');
        if (row) {
          const dot = row.querySelector('.cf-dot');
          if (dot) dot.style.background = input.value;
          const reset = row.querySelector('.opt-course-color-reset');
          if (reset) reset.disabled = false;
        }
      });
    });

    container.querySelectorAll('.opt-course-color-reset').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-reset-key');
        if (!key) return;
        const courseColors = Object.assign({}, getOptions().courseColors);
        delete courseColors[key];
        saveOptions({ courseColors });
        applyColorOptions();
        // Reset restores the auto color, so rebuild the row's swatch state.
        renderOptionsView(container);
      });
    });
  }