import { state } from '../state.js';
import { ensureDiningMenusForDate, getDiningHallStatus } from '../services/dining-api.js';
import { escapeHTML } from '../utils/text.js';

export function isDefaultMainStation(name, hallNum) {
    if (!name) return false;
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (hallNum === 30) {
      return clean.includes('mainlineleft') || clean.includes('mainline');
    }
    return clean.includes('dailydish') || clean.includes('mainline');
  }

export function cleanStationLabel(st) {
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
    if (state.activeDiningHall !== 80 && state.activeDiningHall !== 30) {
      state.activeDiningHall = 80;
    }
    if (state.activeDiningDayOffset !== 1) {
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

    <!-- VisionOS Radial Pie Trigger -->
    <div class="dining-station-pie-wrap" id="dining-station-pie-wrap">
    <button type="button" class="dining-pie-trigger" id="dining-pie-trigger" title="Hover to change station">
    <span class="pie-trigger-label" id="dining-pie-label">Dish</span>
    <span class="pie-trigger-caret">▾</span>
    </button>
    <div class="dining-radial-menu" id="dining-radial-menu"></div>
    </div>
    </div>

    <div id="dining-menu-body">
    <div class="mod-empty-msg">Loading menus...</div>
    </div>
    `;

    // The data currently on screen (today's cache or another day's peek) and
    // the day it belongs to. Internal re-renders (station slice, hall pill,
    // reset) re-draw from these instead of assuming state.diningCache, which
    // only ever holds today.
    let activeData = null;
    let activeDate = null;

    // Generation token guarding every `await ensureDiningMenusForDate(...)`
    // below. FoodPro is slow, so requests for different days land out of
    // order: click "Tomorrow" (cold, ~2s) then "Today" (cached, instant) and
    // without this the Today paint would be immediately overwritten by the
    // late Tomorrow response — leaving tomorrow's menu under a highlighted
    // "Today" pill. Each selection bumps the counter and captures it; a
    // response whose counter is stale is dropped instead of painted.
    let renderSeq = 0;

    function dateForOffset(offset) {
      const d = new Date();
      d.setDate(d.getDate() + offset); // 0 = today, 1 = tomorrow
      return d;
    }

    function renderActiveHall(data, dateObj) {
      const menuBody = document.getElementById('dining-menu-body');
      const pieMenu = document.getElementById('dining-radial-menu');
      const pieLabel = document.getElementById('dining-pie-label');
      const pieWrap = document.getElementById('dining-station-pie-wrap');
      if (!menuBody) return;

      menuBody.innerHTML = '';
      const meals = (data && data[state.activeDiningHall]) ? data[state.activeDiningHall] : [];
      const isToday = !dateObj || dateObj.toDateString() === new Date().toDateString();

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
          statusBanner.querySelector('.status-indicator-text').textContent = statusInfo.label;
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
      if ((data && data.status) ? data.status[state.activeDiningHall] === 'error' : false) {
        if (pieWrap) pieWrap.style.display = 'none';
        const errMsg = document.createElement('div');
        errMsg.className = 'mod-empty-msg';
        errMsg.innerHTML = `Couldn't load the menu — FoodPro is unreachable right now.<br><span class="dining-retry-link" style="color:var(--primary-accent); cursor:pointer; font-size:11px; font-weight:700; margin-top:6px; display:inline-block;">Retry ↗</span>`;
        menuBody.appendChild(errMsg);
        const retryBtn = errMsg.querySelector('.dining-retry-link');
        if (retryBtn) {
          retryBtn.addEventListener('click', async () => {
            retryBtn.textContent = 'Retrying…';
            // Same generation guard as the day pills: a forced refetch is the
            // slowest request this view makes, so it is the most likely to land
            // after the user has already switched to another day.
            const seq = ++renderSeq;
            const fresh = await ensureDiningMenusForDate(dateObj, { force: true });
            if (seq !== renderSeq) return;
            activeData = fresh;
            renderActiveHall(fresh, dateObj);
          });
        }
        return;
      }

      if (meals.length === 0) {
        if (pieWrap) pieWrap.style.display = 'none';
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'mod-empty-msg';
        emptyMsg.innerText = isToday ? 'No menu posted today or dining hall is closed.' : 'No menu posted for that day yet.';
        menuBody.appendChild(emptyMsg);
        return;
      }

      if (pieWrap) pieWrap.style.display = 'inline-flex';

      // Scan all unique station names present for this day
      const allStationsSet = new Set();
      meals.forEach(m => {
        (m.categories || []).forEach(c => {
          if (c.name && c.items && c.items.length > 0) {
            allStationsSet.add(c.name);
          }
        });
      });

      const uniqueStations = Array.from(allStationsSet);
      const defaultStationName = state.activeDiningHall === 30 ? 'Main Line Left' : 'The Daily Dish';

      // Update the trigger button text
      if (pieLabel) {
        if (state.activeStationFilter === '__DEFAULT__') {
          pieLabel.textContent = state.activeDiningHall === 30 ? 'Main Line' : 'Daily Dish';
        } else if (state.activeStationFilter === 'ALL') {
          pieLabel.textContent = 'All Items';
        } else {
          const short = cleanStationLabel(state.activeStationFilter);
          pieLabel.textContent = short.length > 9 ? `${short.slice(0, 8)}…` : short;
        }
      }

      // Build Radial Pie Slices
      if (pieMenu) {
        pieMenu.innerHTML = '';
        const pieOptions = [
          { key: '__DEFAULT__', label: state.activeDiningHall === 30 ? 'Main' : 'Daily', title: defaultStationName },
          { key: 'ALL', label: 'All', title: 'All Stations' },
          ...uniqueStations.map(st => ({
            key: st,
            label: cleanStationLabel(st),
                                       title: st
          }))
        ];
        const totalSlices = pieOptions.length;
        const angleStep = 360 / totalSlices;

        // Decorative Plate Center Hub
        const centerHub = document.createElement('div');
        centerHub.className = 'dining-plate-center-hub';
        centerHub.innerHTML = `<span>🍽️</span>`;
        pieMenu.appendChild(centerHub);

        pieOptions.forEach((opt, idx) => {
          const sliceBtn = document.createElement('button');
          sliceBtn.type = 'button';
          const isSelected = state.activeStationFilter === opt.key;
          sliceBtn.className = `dining-pie-slice ${isSelected ? 'active' : ''}`;
          sliceBtn.title = opt.title;

          sliceBtn.style.setProperty('--slice-rot', `${idx * angleStep}deg`);
          sliceBtn.style.setProperty('--slice-skew', `${Math.max(0, 90 - angleStep)}deg`);

          // Calculate radial coordinates along the recessed inner well of the plate
          const midAngleDeg = (idx * angleStep) + (angleStep / 2) - 90;
          const midAngleRad = (midAngleDeg * Math.PI) / 180;
          const radius = 104; // Positioned right along the rim slope
          const labelX = Math.round(140 + radius * Math.cos(midAngleRad));
          const labelY = Math.round(140 + radius * Math.sin(midAngleRad));
          sliceBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.activeStationFilter = opt.key;
            if (pieWrap) pieWrap.classList.add('is-closed');
            renderActiveHall(activeData, dateObj);
          });
          pieMenu.appendChild(sliceBtn);

          // Direct upright label pinned to plate rim
          const labelEl = document.createElement('span');
          labelEl.className = `dining-plate-label ${isSelected ? 'active' : ''}`;
          labelEl.textContent = opt.label;
          labelEl.style.left = `${labelX}px`;
          labelEl.style.top = `${labelY}px`;
          labelEl.addEventListener('click', (e) => {
            e.stopPropagation();
            sliceBtn.click();
          });
          pieMenu.appendChild(labelEl);
        });
        if (pieWrap) {
          pieWrap.addEventListener('mouseleave', () => {
            pieWrap.classList.remove('is-closed');
          });
        }
      }

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
        const displayStation = state.activeStationFilter === '__DEFAULT__' ? defaultStationName : state.activeStationFilter;
        noItems.innerHTML = `No items found under "<strong>${escapeHTML(displayStation)}</strong>".<br><span style="color:var(--primary-accent); cursor:pointer; font-size:11px; font-weight:700; margin-top:6px; display:inline-block;" id="dining-reset-all">Show All Stations ↗</span>`;
        menuBody.appendChild(noItems);

        const resetBtn = noItems.querySelector('#dining-reset-all');
        if (resetBtn) {
          resetBtn.addEventListener('click', () => {
            state.activeStationFilter = 'ALL';
            renderActiveHall(activeData, dateObj);
          });
        }
      } else {
        menuBody.appendChild(stackContainer);
      }
    }

    // Lightweight placeholder for a day whose fetch hasn't finished yet — shows
    // the "X menu" banner immediately so the toggle feels instant instead of
    // leaving the previous day's food on screen during a cold fetch.
    function renderDayLoading(dateObj) {
      const menuBody = document.getElementById('dining-menu-body');
      if (!menuBody) return;
      menuBody.innerHTML = '';
      const statusBanner = document.createElement('div');
      statusBanner.className = 'dining-status-banner';
      statusBanner.innerHTML = `<span class="status-indicator-text">${escapeHTML(dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} menu</span>`;
      menuBody.appendChild(statusBanner);
      const loading = document.createElement('div');
      loading.className = 'mod-empty-msg';
      loading.innerText = 'Loading menus…';
      menuBody.appendChild(loading);
    }

    const pills = listContainer.querySelectorAll('.dining-pill[data-hall]');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeDiningHall = parseInt(pill.getAttribute('data-hall'), 10);
        state.activeStationFilter = '__DEFAULT__'; // Resets to hall's main dish
        renderActiveHall(activeData, activeDate);
      });
    });

    // Today / Tomorrow toggle — FoodPro serves other days via dtdate, so a
    // peek just re-fetches with tomorrow's date (cached per day on fetch).
    // Both days are prefetched on first render below, so this usually resolves
    // from cache instantly; a cold fetch shows a placeholder immediately.
    const dayPills = listContainer.querySelectorAll('.dining-day-pills .dining-pill[data-dayoffset]');
    dayPills.forEach(pill => {
      pill.addEventListener('click', async () => {
        dayPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeDiningDayOffset = parseInt(pill.getAttribute('data-dayoffset'), 10);
        state.activeStationFilter = '__DEFAULT__';
        const seq = ++renderSeq;
        activeDate = dateForOffset(state.activeDiningDayOffset);
        if (!state.diningByDateCache[activeDate.toDateString()]) {
          renderDayLoading(activeDate);
        }
        const data = await ensureDiningMenusForDate(activeDate);
        if (seq !== renderSeq) return; // a newer day was picked — drop this
        activeData = data;
        renderActiveHall(activeData, activeDate);
      });
    });

    // Kick off both days at once — FoodPro is slow, so starting tomorrow's
    // fetch in parallel with today's means the toggle is a cache hit by the
    // time the user gets there. Deduping in dining-api means the awaited call
    // below and these fire-and-forget calls share one request per day.
    ensureDiningMenusForDate(dateForOffset(0)).catch(() => {});
    ensureDiningMenusForDate(dateForOffset(1)).catch(() => {});

    const seq = ++renderSeq;
    activeDate = dateForOffset(state.activeDiningDayOffset);
    const data = await ensureDiningMenusForDate(activeDate);
    if (seq !== renderSeq) return; // user already clicked another day
    activeData = data;
    renderActiveHall(activeData, activeDate);
  }
