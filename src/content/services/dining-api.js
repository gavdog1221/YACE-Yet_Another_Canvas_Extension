import { state } from '../state.js';
import { STORAGE_KEY_DINING_MENUS } from '../constants.js';

export function parseMenuHtml(htmlString) {
    if (!htmlString) return [];
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    const meals = [];
    let currentMeal = null;
    let currentCategory = null;

    doc.querySelectorAll('.shortmenumeals, .shortmenucats, .shortmenurecipes').forEach(el => {
      if (el.classList.contains('shortmenumeals')) {
        const rawMealText = el.textContent.trim();
        // Check if FoodPro included times in the meal label (e.g., "Lunch (11:00am - 2:00pm)")
        const timeMatch = rawMealText.match(/\((.*?)\)/);
        const mealTitle = rawMealText.replace(/\(.*?\)/, '').trim();

        currentMeal = {
          meal: mealTitle,
          hours: timeMatch ? timeMatch[1] : null,
          categories: []
        };
        meals.push(currentMeal);
        currentCategory = null;
      } else if (el.classList.contains('shortmenucats') && currentMeal) {
        const catName = el.textContent.replace(/--/g, '').trim();
        currentCategory = { name: catName, items: [] };
        currentMeal.categories.push(currentCategory);
      } else if (el.classList.contains('shortmenurecipes') && currentCategory) {
        const dishName = el.textContent.trim();
        if (!dishName) return;

        const traits = [];
        const container = el.closest('tr') || el;
        const imgs = container.querySelectorAll('img');

        imgs.forEach(img => {
          const alt = (img.getAttribute('alt') || '').toLowerCase();
          const src = (img.getAttribute('src') || '').toLowerCase();
          if (alt.includes('vegan') || src.includes('vgn') || src.includes('vegan')) {
            traits.push('vgn');
          } else if (alt.includes('vegetarian') || src.includes('veg')) {
            traits.push('veg');
          }
          if (alt.includes('gluten') || src.includes('gf') || alt.includes('wheat free')) {
            traits.push('gf');
          }
          if (alt.includes('halal') || src.includes('halal')) {
            traits.push('halal');
          }
        });

        currentCategory.items.push({
          name: dishName,
          traits: Array.from(new Set(traits))
        });
      }
    });

    return meals;
  }

export function parseMinutesFromTimeString(str) {
    const m = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = m[2] ? parseInt(m[2], 10) : 0;
    const isPm = m[3].toLowerCase() === 'pm';
    if (isPm && hours !== 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

export function matchesDayAbbr(str, dayIdx) {
    // dayIdx: 0 = Sun, 1 = Mon, ..., 6 = Sat
    const map = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const target = map[dayIdx];
    const s = str.toLowerCase();

    // Check direct match, e.g. "sun:", "thu:"
    if (s.startsWith(target)) return true;

    // Check range matches, e.g. "mon - fri:", "mon - wed:"
    const rangeMatch = s.match(/([a-z]{3})\s*[-–—]\s*([a-z]{3})/i);
    if (rangeMatch) {
      const start = map.indexOf(rangeMatch[1].toLowerCase());
      const end = map.indexOf(rangeMatch[2].toLowerCase());
      if (start !== -1 && end !== -1) {
        if (start <= end) {
          return dayIdx >= start && dayIdx <= end;
        } else {
          // Wrapped range like Fri - Mon
          return dayIdx >= start || dayIdx <= end;
        }
      }
    }
    return false;
  }

export async function fetchLiveDiningHours() {
    if (state.cachedOfficialHours) return state.cachedOfficialHours;

    const response = await browser.runtime.sendMessage({ type: 'FETCH_DINING_HOURS' }).catch(() => null);
    if (!response || !response.success || !response.html) {
      return null;
    }

    const doc = new DOMParser().parseFromString(response.html, 'text/html');
    const todayIdx = new Date().getDay();
    const parsedHours = { 80: null, 30: null };

    // Break page into sections by dining hall
    const textAll = doc.body ? doc.body.innerText : '';
    const hocoIndex = textAll.search(/holloway commons/i);
    const phillyIndex = textAll.search(/philbrook/i);

    const sections = [];
    if (hocoIndex !== -1 && phillyIndex !== -1) {
      if (hocoIndex < phillyIndex) {
        sections.push({ hall: 80, text: textAll.slice(hocoIndex, phillyIndex) });
        sections.push({ hall: 30, text: textAll.slice(phillyIndex) });
      } else {
        sections.push({ hall: 30, text: textAll.slice(phillyIndex, hocoIndex) });
        sections.push({ hall: 80, text: textAll.slice(hocoIndex) });
      }
    }

    sections.forEach(({ hall, text }) => {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const isCurrentlyOpen = text.toLowerCase().includes('currently open');

      let todayTimeRange = null;
      let isExplicitClosed = false;

      for (let i = 0; i < lines.length; i++) {
        if (matchesDayAbbr(lines[i], todayIdx)) {
          // Next 1 or 2 lines usually contain the time or "Closed"
          const nextLines = lines.slice(i + 1, i + 3).join(' ');
          if (/closed/i.test(nextLines)) {
            isExplicitClosed = true;
            break;
          }
          const m = nextLines.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
          if (m) {
            todayTimeRange = m;
            break;
          }
        }
      }

      parsedHours[hall] = {
        isCurrentlyOpen: isCurrentlyOpen,
        isExplicitClosed: isExplicitClosed,
        openStr: todayTimeRange ? todayTimeRange[1] : null,
        closeStr: todayTimeRange ? todayTimeRange[2] : null,
        openMin: todayTimeRange ? parseMinutesFromTimeString(todayTimeRange[1]) : null,
                     closeMin: todayTimeRange ? parseMinutesFromTimeString(todayTimeRange[2]) : null
      };
    });

    state.cachedOfficialHours = parsedHours;
    return parsedHours;
  }

export async function getDiningHallStatus(hallNum, meals) {
    const now = new Date();
    const dayIdx = now.getDay(); // 0 = Sun, 6 = Sat

    // Philbrook (hall 30) doesn't open at all on weekends. That's a fixed
    // fact, so it's checked before anything else rather than relying on
    // the live-scraped hours page (or the generic time-only fallback
    // further down) to catch it -- if that scrape ever fails or doesn't
    // parse Saturday/Sunday cleanly, this is the floor that keeps Philly
    // from showing as open when it isn't.
    if (hallNum === 30 && (dayIdx === 0 || dayIdx === 6)) {
      return { isOpen: false, label: 'Closed for the weekend' };
    }

    const hoursData = await fetchLiveDiningHours();
    const live = hoursData ? hoursData[hallNum] : null;

    if (live) {
      if (live.isExplicitClosed) {
        return { isOpen: false, label: 'Closed Today' };
      }

      const curMinutes = now.getHours() * 60 + now.getMinutes();

      // `!= null`, not a truthiness test: parseMinutesFromTimeString('12:00 am')
      // legitimately returns 0, so a hall that opens or closes at midnight was
      // being treated as "no live hours" and silently dropped through to the
      // hardcoded 7:15 AM - 9:00 PM guess below.
      if (live.openMin != null && live.closeMin != null) {
        const openStr = live.openStr.toUpperCase();
        const closeStr = live.closeStr.toUpperCase();

        if (curMinutes >= live.openMin && curMinutes < live.closeMin) {
          return { isOpen: true, label: `Open until ${closeStr}` };
        } else if (curMinutes < live.openMin) {
          return { isOpen: false, label: `Closed until ${openStr}` };
        } else {
          return { isOpen: false, label: `Closed for the night (at ${closeStr})` };
        }
      }

      if (live.isCurrentlyOpen) {
        const defaultClose = hallNum === 80 ? '9:00 PM' : '9:00 PM';
        return { isOpen: true, label: `Currently open (closes ~${defaultClose})` };
      }
    }

    // Secondary fallback based on current time
    const curMinutes = now.getHours() * 60 + now.getMinutes();
    const openMin = 435; // 7:15 AM
    const closeMin = 1260; // 9:00 PM

    if (curMinutes >= openMin && curMinutes < closeMin) {
      return { isOpen: true, label: 'Open until 9:00 PM' };
    } else {
      return { isOpen: false, label: 'Closed until 7:15 AM' };
    }
  }

// --- Per-hall, per-day menu caching (in-memory + localStorage) ---
// FoodPro is slow, so a hall's menu is fetched once per day, deduped across
// concurrent callers, cached in state.diningByDateCache, and mirrored to
// localStorage (STORAGE_KEY_DINING_MENUS). Returning to Canvas within the same
// today/tomorrow span never re-hits the slow site; only those two days are
// ever persisted/restored — anything older is stale by definition.
//
// Caching per hall (not per day) is what makes the view feel fast: the hall the
// user is looking at paints the moment ITS request lands instead of waiting on
// the slower of the two halls. Each hall carries its own status
// ('pending' | 'ok' | 'empty' | 'error') so one bad hall never blocks or
// mislabels the other.

const pendingDiningHallFetch = {}; // key: dateString::hallNum -> in-flight Promise

function emptyDiningDay(key) {
    return { date: key, 80: [], 30: [], status: { 80: 'pending', 30: 'pending' } };
  }

function loadDiningPersistence() {
    if (loadDiningPersistence.loaded) return;
    loadDiningPersistence.loaded = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DINING_MENUS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const days = parsed && parsed.days;
      if (!days || typeof days !== 'object') return;

      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const validKeys = new Set([now.toDateString(), tomorrow.toDateString()]);

      Object.keys(days).forEach(k => {
        if (!validKeys.has(k)) return;
        const saved = days[k];
        if (!saved) return;
        // Restore each hall independently. A hall saved with items is served
        // from cache; a hall that failed last session was persisted empty (or
        // not at all), so it refetches now rather than freezing an empty menu.
        const day = emptyDiningDay(k);
        let hasAny = false;
        [80, 30].forEach(hall => {
          if (Array.isArray(saved[hall]) && saved[hall].length > 0) {
            day[hall] = saved[hall];
            day.status[hall] = 'ok';
            hasAny = true;
          }
        });
        if (hasAny) state.diningByDateCache[k] = day;
      });
      const todayKey = now.toDateString();
      if (state.diningByDateCache[todayKey]) {
        state.diningCache = state.diningByDateCache[todayKey];
      }
    } catch (e) {
      console.warn('[YACE] Dining cache hydrate failed:', e);
    }
  }

function persistDiningMenus() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const days = {};
      [now.toDateString(), tomorrow.toDateString()].forEach(k => {
        const day = state.diningByDateCache[k];
        if (!day) return;
        // Persist only halls that actually returned items. An empty hall is
        // usually a fetch failure that must not be frozen into the cache —
        // status metadata is never persisted (it describes a session), and the
        // missing hall refetches next load. Both keys are always written so the
        // stored shape stays `{ date, 80, 30 }`.
        const entry = { date: k, 80: [], 30: [] };
        let hasAny = false;
        [80, 30].forEach(hall => {
          if (day[hall] && day[hall].length) { entry[hall] = day[hall]; hasAny = true; }
        });
        if (hasAny) days[k] = entry;
      });
      if (Object.keys(days).length) {
        localStorage.setItem(STORAGE_KEY_DINING_MENUS, JSON.stringify({ days }));
      }
    } catch (e) {
      console.warn('[YACE] Dining cache persist failed:', e);
    }
  }

// Failed halls are kept for one retry window so repeated interaction with a
// down FoodPro doesn't hammer it on every click; after it elapses (or on an
// explicit retry) the next call refetches, so menus recover without reloading
// the page. The window is short because the tab renders once per session and is
// then kept alive by campus-tools-modal's toolHosts map — the click that follows
// a failure is the thing being rate-limited here.
const DINING_RETRY_WINDOW_MS = 60 * 1000;
const diningHallFetchFailedAt = {}; // key: dateString::hallNum -> last failure ms

// Fetch (or serve from cache) ONE hall's menu for ONE day. Concurrent callers
// for the same hall+day share a single in-flight request, so a view prefetch and
// an immediate hall/day toggle never double-fetch. A failed fetch is cached
// in-memory only (rate-limited by DINING_RETRY_WINDOW_MS) and never written to
// localStorage, so the session and the next session recover. Resolves as soon as
// that hall lands, which is what lets the view stream the visible hall first.
export async function ensureDiningHallForDate(hallNum, dateObj, opts) {
    const force = !!(opts && opts.force);
    loadDiningPersistence();

    const key = dateObj.toDateString();
    const todayKey = new Date().toDateString();
    const hallKey = key + '::' + hallNum;

    let day = state.diningByDateCache[key];
    if (!day) {
      day = emptyDiningDay(key);
      state.diningByDateCache[key] = day;
    }
    if (key === todayKey) state.diningCache = day;

    const cachedStatus = day.status[hallNum];
    const meals = Array.isArray(day[hallNum]) ? day[hallNum] : [];

    // Serve a completed result straight from cache. Errors are held for the
    // retry window; 'empty' (server answered, nothing posted) is terminal for
    // the session so we don't re-hit FoodPro on every re-render.
    if (!force) {
      if (cachedStatus === 'ok') return { meals, status: 'ok' };
      if (cachedStatus === 'empty') return { meals: [], status: 'empty' };
      if (cachedStatus === 'error') {
        const elapsed = Date.now() - (diningHallFetchFailedAt[hallKey] || 0);
        if (elapsed < DINING_RETRY_WINDOW_MS) return { meals, status: 'error' };
      }
    }

    if (pendingDiningHallFetch[hallKey]) return pendingDiningHallFetch[hallKey];

    const dtdate = `${dateObj.getMonth() + 1}/${dateObj.getDate()}/${dateObj.getFullYear()}`;
    const locationName = hallNum === 80 ? 'Holloway Commons' : 'Philbrook';
    const pending = (async () => {
      let status = 'error';
      try {
        const res = await browser.runtime.sendMessage({
          type: 'FETCH_DINING_MENU', locationNum: hallNum, locationName, dtdate
        }).catch(() => null);
        if (res && res.success && res.html) {
          day[hallNum] = parseMenuHtml(res.html);
          status = 'ok';
        } else if (res && !res.success && res.network === false) {
          // FoodPro answered (404/no-content): genuinely nothing posted.
          status = 'empty';
        } else {
          status = 'error';
        }
      } catch (err) {
        console.warn('[YACE] Dining fetch failure:', err);
      }
      if (!Array.isArray(day[hallNum])) day[hallNum] = [];
      day.status[hallNum] = status;
      if (status === 'error') diningHallFetchFailedAt[hallKey] = Date.now();
      if (key === todayKey) state.diningCache = day;
      persistDiningMenus();
      // Diagnostic breadcrumb so a stuck hall is traceable in console.
      if (status !== 'ok') console.info('[YACE] dining ' + hallKey + ' -> ' + status);
      return { meals: day[hallNum], status };
    })();
    pendingDiningHallFetch[hallKey] = pending;
    return pending.finally(() => { delete pendingDiningHallFetch[hallKey]; });
  }
