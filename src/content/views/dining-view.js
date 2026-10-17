import { state } from '../state.js';
import { ensureDiningHallForDate, getDiningHallStatus } from '../services/dining-api.js';
import { escapeHTML } from '../utils/text.js';

function isDefaultMainStation(name, hallNum) {
    if (!name) return false;
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (hallNum === 30) {
      return clean.includes('mainlineleft') || clean.includes('mainline');
    }
    return clean.includes('dailydish') || clean.includes('mainline');
  }

function cleanStationLabel(st) {
    let clean = st.replace(/^--\s*|\s*--$/g, '')
    .replace(/^The\s+/i, '')
    .replace(/Specialties|Creations|Station|Bar\b/gi, '')
    .trim();
    const map = {
      'Holloway Deli': 'Deli',
      'Vegan': 'Vegan',
      'Corner': 'Corner',
      'Daily Dish': 'Daily Dish',
      'Allergen Friendly': 'Allergen',
      'Soup and More': 'Soups',
      'Pasta': 'Pasta',
      'Desserts': 'Desserts',
      'Breakfast Nook': 'Breaky',
      'Main Line Left': 'Main Line',
      'Grill Specialty': 'Grill'
    };
    return map[clean] || clean;
  }

export async function renderDiningView(listContainer) {
    // Never trust stale session state: only the two halls and two days this
    // view supports are valid defaults.
    if (state.activeDiningHall !== 80 && state.activeDiningHall !== 30) {
      state.activeDiningHall = 80;
    }
    if (state.activeDiningDayOffset !== 0 && state.activeDiningDayOffset !== 1) {
      state.activeDiningDayOffset = 0;
    }

    listContainer.innerHTML = `
    <div class="dining-header-controls">
    <div class="dining-left-controls">
    <div class="dining-hall-pills">
    <button type="button" class="dining-pill ${state.activeDiningHall === 80 ? 'active' : ''}" data-hall="80">HoCo</button>
    <button type="button" class="dining-pill ${state.activeDiningHall === 30 ? 'active' : ''}" data-hall="30">Philly</button>
    </div>
    <div class="dining-day-pills">
    <button type="button" class="dining-pill ${state.activeDiningDayOffset === 0 ? 'active' : ''}" data-dayoffset="0">Today</button>
    <button type="button" class="dining-pill ${state.activeDiningDayOffset === 1 ? 'active' : ''}" data-dayoffset="1">Tomorrow</button>
    </div>
    </div>
    </div>

    <div class="dining-station-bar" id="dining-station-bar"></div>

    <div id="dining-menu-body">
    <div class="mod-empty-msg">Loading menus...</div>
    </div>
    `;

    const dateForOffset = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset); // 0 = today, 1 = tomorrow
      return d;
    };

    // The data currently on screen and the day it belongs to. Station/hall
    // re-renders redraw from these closure vars rather than re-reading global
    // state, so a click never depends on a fetch having finished.
    let activeDate = dateForOffset(state.activeDiningDayOffset);
    let activeMeals = [];
    let activeStatus = 'pending';

    // Generation token guarding every `await ensureDiningHallForDate(...)`.
    // FoodPro is slow, so requests for different hall/day combos land out of
    // order: click "Tomorrow" (cold) then "Today" (cached, instant) and without
    // this the instant paint would be overwritten by the late response —
    // leaving tomorrow's menu under a highlighted "Today" pill. Each selection
    // bumps the counter and captures it; a stale response is dropped, not drawn.
    let renderSeq = 0;

    // Simple retro toolbar that replaces the old radial dinner-plate picker:
    // Main / All / one beveled button per station present in the day's menu.
    function buildStationBar(meals) {
      const bar = document.getElementById('dining-station-bar');
      if (!bar) return;
      bar.innerHTML = '';

      const hasDishes = (meals || []).some(m => (m.categories || []).some(c => c.items && c.items.length));
      if (!hasDishes) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'flex';

      const stations = new Set();
      meals.forEach(m => (m.categories || []).forEach(c => {
        if (c.name && c.items && c.items.length > 0) stations.add(c.name);
      }));

      const options = [
        { key: '__DEFAULT__', label: state.activeDiningHall === 30 ? 'Main Line' : 'Daily Dish', title: 'Main station' },
        { key: 'ALL', label: 'All', title: 'All stations' },
        ...Array.from(stations).map(st => ({ key: st, label: cleanStationLabel(st), title: st }))
      ];

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dining-station-btn' + (state.activeStationFilter === opt.key ? ' active' : '');
        btn.textContent = opt.label;
        btn.title = opt.title;
        btn.addEventListener('click', () => {
          state.activeStationFilter = opt.key;
          renderActiveHall();
        });
        bar.appendChild(btn);
      });
    }

    function renderActiveHall() {
      const menuBody = document.getElementById('dining-menu-body');
      if (!menuBody) return;

      const dateObj = activeDate;
      const meals = activeMeals || [];
      const isToday = dateObj.toDateString() === new Date().toDateString();

      menuBody.innerHTML = '';

      const statusBanner = document.createElement('div');
      statusBanner.className = 'dining-status-banner';
      if (isToday) {
        statusBanner.innerHTML = `
        <span class="status-indicator-dot"></span>
        <span class="status-indicator-text">Checking hours...</span>
        `;
        menuBody.appendChild(statusBanner);

        getDiningHallStatus(state.activeDiningHall, meals).then(statusInfo => {
          statusBanner.className = `dining-status-banner ${statusInfo.isOpen ? 'is-open' : 'is-closed'}`;
          const label = statusBanner.querySelector('.status-indicator-text');
          if (label) label.textContent = statusInfo.label;
        });
      } else {
        // Live open/closed status only means something right now — for any
        // other day, say which day's menu this actually is instead.
        statusBanner.innerHTML = `<span class="status-indicator-text">${escapeHTML(dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} menu</span>`;
        menuBody.appendChild(statusBanner);
      }

      // A real fetch failure (FoodPro unreachable/timeout) is different from a
      // day with no menu posted — say so and offer a retry that bypasses the
      // rate-limited failure cache.
      if (activeStatus === 'error') {
        buildStationBar([]);
        const errMsg = document.createElement('div');
        errMsg.className = 'mod-empty-msg';
        errMsg.innerHTML = `Couldn't load the menu — FoodPro is unreachable right now.<br><span class="dining-retry-link" style="color:var(--primary-accent); cursor:pointer; font-size:11px; font-weight:700; margin-top:6px; display:inline-block;">Retry ↗</span>`;
        menuBody.appendChild(errMsg);
        const retryBtn = errMsg.querySelector('.dining-retry-link');
        if (retryBtn) {
          retryBtn.addEventListener('click', async () => {
            retryBtn.textContent = 'Retrying…';
            await refresh({ force: true });
          });
        }
        return;
      }

      if (meals.length === 0) {
        buildStationBar([]);
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'mod-empty-msg';
        emptyMsg.innerText = isToday ? 'No menu posted today or dining hall is closed.' : 'No menu posted for that day yet.';
        menuBody.appendChild(emptyMsg);
        return;
      }

      buildStationBar(meals);

      const stackContainer = document.createElement('div');
      stackContainer.className = 'dining-rows-stack';
      let totalVisibleDishes = 0;

      meals.forEach(meal => {
        let visibleCats = (meal.categories || []).filter(cat => cat.items && cat.items.length > 0);

        if (state.activeStationFilter === '__DEFAULT__') {
          visibleCats = visibleCats.filter(cat => isDefaultMainStation(cat.name, state.activeDiningHall));
        } else if (state.activeStationFilter !== 'ALL') {
          visibleCats = visibleCats.filter(cat => cat.name.toLowerCase() === state.activeStationFilter.toLowerCase());
        }

        if (visibleCats.length === 0 && state.activeStationFilter !== 'ALL') {
          return;
        }

        const mealRow = document.createElement('div');
        mealRow.className = 'dining-meal-row';

        let categoriesHtml = '';
        visibleCats.forEach(cat => {
          totalVisibleDishes += cat.items.length;
          categoriesHtml += `
          <div class="dining-station-group">
          <div class="dining-station-title">${escapeHTML(cat.name)}</div>
          <ul class="dining-item-list">
          ${cat.items.map(dishObj => {
            const name = typeof dishObj === 'string' ? dishObj : dishObj.name;
            const traits = (dishObj && dishObj.traits) || [];
            const badgeHtml = traits.map(t => {
              if (t === 'vgn') return '<span class="diet-dot vgn" title="Vegan">VG</span>';
              if (t === 'veg') return '<span class="diet-dot veg" title="Vegetarian">V</span>';
              if (t === 'gf') return '<span class="diet-dot gf" title="Gluten-Friendly">GF</span>';
              if (t === 'halal') return '<span class="diet-dot halal" title="Halal">H</span>';
              return '';
            }).join('');

            return `<li><span class="dish-name-text">${escapeHTML(name)}</span>${badgeHtml ? `<span class="diet-badges">${badgeHtml}</span>` : ''}</li>`;
          }).join('')}
          </ul>
          </div>
          `;
        });

        mealRow.innerHTML = `
        <div class="dining-meal-header">
        <span class="dining-meal-name">${escapeHTML(meal.meal)}</span>
        ${meal.hours ? `<span class="dining-meal-hours">${escapeHTML(meal.hours)}</span>` : ''}
        </div>
        <div class="dining-stations-wrap">
        ${categoriesHtml || '<div class="dining-empty-sub">No items available.</div>'}
        </div>
        `;
        stackContainer.appendChild(mealRow);
      });

      if (totalVisibleDishes === 0) {
        const noItems = document.createElement('div');
        noItems.className = 'mod-empty-msg';
        const displayStation = state.activeStationFilter === '__DEFAULT__'
          ? (state.activeDiningHall === 30 ? 'Main Line Left' : 'The Daily Dish')
          : state.activeStationFilter;
        noItems.innerHTML = `No items found under "<strong>${escapeHTML(displayStation)}</strong>".<br><span style="color:var(--primary-accent); cursor:pointer; font-size:11px; font-weight:700; margin-top:6px; display:inline-block;" id="dining-reset-all">Show All Stations ↗</span>`;
        menuBody.appendChild(noItems);

        const resetBtn = noItems.querySelector('#dining-reset-all');
        if (resetBtn) {
          resetBtn.addEventListener('click', () => {
            state.activeStationFilter = 'ALL';
            renderActiveHall();
          });
        }
      } else {
        menuBody.appendChild(stackContainer);
      }
    }

    // Lightweight placeholder for a hall/day whose fetch hasn't finished yet —
    // shows the day banner immediately so a toggle feels instant instead of
    // leaving the previous selection's food on screen during a cold fetch.
    function renderLoading(dateObj) {
      const menuBody = document.getElementById('dining-menu-body');
      if (!menuBody) return;
      menuBody.innerHTML = '';
      const statusBanner = document.createElement('div');
      statusBanner.className = 'dining-status-banner';
      statusBanner.innerHTML = `<span class="status-indicator-text">${escapeHTML(dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} menu</span>`;
      menuBody.appendChild(statusBanner);
      const bar = document.getElementById('dining-station-bar');
      if (bar) bar.style.display = 'none';
      const loading = document.createElement('div');
      loading.className = 'mod-empty-msg';
      loading.innerText = 'Loading menus…';
      menuBody.appendChild(loading);
    }

    // Draw the current hall/day. If that hall is already resolved it paints
    // immediately; otherwise a placeholder goes up and the paint waits only on
    // THIS hall (never the other one), which is the whole point of the per-hall
    // fetch. `force` bypasses the rate-limited failure cache for Retry.
    async function refresh(opts) {
      const force = !!(opts && opts.force);
      const seq = ++renderSeq;
      activeDate = dateForOffset(state.activeDiningDayOffset);

      const day = state.diningByDateCache[activeDate.toDateString()];
      const cachedStatus = day ? day.status[state.activeDiningHall] : 'pending';

      if (force || cachedStatus === 'pending') {
        renderLoading(activeDate);
      } else {
        activeMeals = (day && day[state.activeDiningHall]) || [];
        activeStatus = cachedStatus;
        renderActiveHall();
        if (cachedStatus !== 'error') return;
      }

      const res = await ensureDiningHallForDate(state.activeDiningHall, activeDate, { force });
      if (seq !== renderSeq) return; // user already switched hall/day
      activeMeals = res.meals;
      activeStatus = res.status;
      renderActiveHall();
    }

    // Warm the combos the pills can reach that aren't on screen yet. Called
    // only AFTER the visible hall has painted, so the first request isn't
    // competing with three other requests on the same slow FoodPro host; by the
    // time a pill is clicked the data is usually already cached.
    function warmOtherCombos() {
      const combos = [
        [80, dateForOffset(0)], [30, dateForOffset(0)],
        [80, dateForOffset(1)], [30, dateForOffset(1)]
      ];
      combos.forEach(([hall, d]) => {
        const day = state.diningByDateCache[d.toDateString()];
        const st = day ? day.status[hall] : 'pending';
        if (st === 'pending' || st === 'error') {
          ensureDiningHallForDate(hall, d).catch(() => {});
        }
      });
    }

    const hallPills = listContainer.querySelectorAll('.dining-hall-pills .dining-pill[data-hall]');
    hallPills.forEach(pill => {
      pill.addEventListener('click', async () => {
        hallPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeDiningHall = parseInt(pill.getAttribute('data-hall'), 10);
        state.activeStationFilter = '__DEFAULT__'; // reset to the hall's main dish
        await refresh();
        warmOtherCombos();
      });
    });

    // Today / Tomorrow toggle — FoodPro serves other days via dtdate, so a peek
    // refetches with that date (cached per hall/day). The other days are warmed
    // in the background, so a toggle usually resolves from cache instantly.
    const dayPills = listContainer.querySelectorAll('.dining-day-pills .dining-pill[data-dayoffset]');
    dayPills.forEach(pill => {
      pill.addEventListener('click', async () => {
        dayPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeDiningDayOffset = parseInt(pill.getAttribute('data-dayoffset'), 10);
        state.activeStationFilter = '__DEFAULT__';
        await refresh();
        warmOtherCombos();
      });
    });

    await refresh();
    warmOtherCombos();
  }
