const RMP_GRAPHQL_URL = 'https://www.ratemyprofessors.com/graphql';
// University of New Hampshire (all campuses) — RMP global ID (legacyId 1231).
const RMP_SCHOOL_ID = 'U2Nob29sLTEyMzE=';
// UNH Academic Core Calendar, published by the Registrar on their 25Live/Trumba
// host as a static iCalendar feed (holidays, breaks, exam blocks, schedule
// changes, weather/closure notices).
const UNH_ACADEMIC_CALENDAR_ICS = 'https://25livepub.collegenet.com/calendars/unh-academic-core-calendar.ics';

// --- WebCat CRN lookup (term codes only) ---
// Courses are resolved through the *public* UNH course catalog
// (courses.unh.edu /class/{termCode}/{crn} pages) — no auth, no session,
// and no requirement that a WebCat tab be open. WebCat itself is only
// consulted for its public term list, and only when the saved term label
// can't be mapped from its deterministic scheme (<year><season>: fall=10,
// january=30, spring=50, summer=70).

const WEBCAT_BASE = 'https://webcat.unh.edu/StudentRegistrationSsb/ssb';
const webCatTermCache = new Map();
const coursePageCache = new Map(); // key: termCode::crn -> { t, section }
const termAvailabilityCache = new Map(); // key: termCode -> { t, available }
const COURSE_PAGE_CACHE_MS = 10 * 60 * 1000;

async function fetchWebCatTerms() {
    const res = await fetch(WEBCAT_BASE + '/classSearch/getTerms?offset=1&max=60&searchTerm=', { credentials: 'include' });
    if (!res.ok) throw new Error('WebCat term list returned HTTP ' + res.status);
    return await res.json();
}

function matchWebCatTermCode(terms, label) {
    const L = String(label).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!L) return null;

    // UNH term codes: <year><season> where fall=10, january=30,
    // spring=50, summer=70 (verified via getTerms).
    const yearMatch = L.match(/(20\d\d)/);
    const season = /summer/.test(L) ? '70'
        : /january|j[-\s]?term|winter/.test(L) ? '30'
        : /spring/.test(L) ? '50'
        : /fall/.test(L) ? '10' : '';
    if (yearMatch && season) {
        const want = yearMatch[1] + season;
        const hit = terms.find(t => t.code === want);
        if (hit) return hit.code;
    }

    const normalized = L.replace(/\(view only\)/g, '').replace(/\s+/g, '').trim();
    const hit = terms.find(t => {
        const desc = String(t.description || '').toLowerCase().replace(/\(view only\)/g, '').replace(/\s+/g, '').trim();
        return desc === normalized;
    });
    return hit ? hit.code : null;
}

async function getWebCatTermCode(label) {
    if (!label) throw new Error('No term entered — type it exactly as it appears on the WebCat registration page (e.g. "Fall 2026").');
    const direct = termCodeFromLabel(label);
    if (direct) return direct;
    if (webCatTermCache.has(label)) return webCatTermCache.get(label);
    const code = matchWebCatTermCode(await fetchWebCatTerms(), label);
    if (!code) throw new Error('Could not map term "' + label + '" to a UNH term code.');
    webCatTermCache.set(label, code);
    return code;
}

// Deterministic mapping for typical saved labels ("Fall 2026" -> "202610").
function termCodeFromLabel(label) {
    const L = String(label || '').toLowerCase().trim().replace(/\(view only\)/g, '').replace(/\s+/g, ' ');
    const yearMatch = L.match(/(20\d\d)/);
    const season = /summer/.test(L) ? '70'
        : /january|j[-\s]?term|winter/.test(L) ? '30'
        : /spring/.test(L) ? '50'
        : /fall/.test(L) ? '10' : '';
    if (yearMatch && season) return yearMatch[1] + season;
    return null;
}

// "202410" -> "Fall 2024" (season codes match WebCat: fall=10, jan=30,
// spring=50, summer=70). Used to label course-search results by term.
function termCodeToLabel(code) {
    const s = String(code || '');
    const year = s.slice(0, 4);
    const seasonMap = { '10': 'Fall', '30': 'January', '50': 'Spring', '70': 'Summer' };
    const season = seasonMap[s.slice(4)];
    return year && season ? `${season} ${year}` : (s || '');
}

const COURSES_BASE = 'https://courses.unh.edu';

function decodeEntities(str) {
    return String(str == null ? '' : str)
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Raw text following `opener`, up to the next tag.
function textUntilTag(str, opener) {
    const i = String(str).indexOf(opener);
    if (i < 0) return '';
    return decodeEntities(String(str).slice(i + opener.length).split('<')[0]);
}

// Text inside the <div> that starts with `label` ("<b>Prerequisite(s):</b>").
// Preserves "or"/"and" groupings between <span class='prereq-name'> items.
function requirementText(html, labels) {
    for (const label of labels) {
        const i = String(html).indexOf(label);
        if (i < 0) continue;
        let seg = String(html).slice(i + label.length);
        const end = seg.indexOf('</div>');
        if (end >= 0) seg = seg.slice(0, end);
        const out = decodeEntities(seg.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (out) return out;
    }
    return '';
}

// "8:10am" -> "0810", "12:00pm" -> "1200", "12:30am" -> "0030". null on junk.
function parseCourseTime(raw) {
    const s = String(raw || '').replace(/\s+/g, '').toLowerCase();
    const m = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + String(min).padStart(2, '0');
}

// "11:10am - 12:00pm" -> { start: "1110", end: "1200" }. null on junk.
function parseCourseTimeRange(raw) {
    const m = String(raw || '').trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!m) return null;
    const start = parseCourseTime(m[1]);
    const end = parseCourseTime(m[2]);
    if (start === null || end === null) return null;
    return { start, end };
}

// "MWF" / "T R" -> ["M","W","F"]
function parseDaysStr(raw) {
    const out = [];
    for (const ch of String(raw || '')) {
        const u = ch.toUpperCase();
        if ('MTWRFSU'.includes(u) && !out.includes(u)) out.push(u);
    }
    return out;
}

// Parses the public section page at /class/{termCode}/{crn}. Mirrors the
// shape the widget/pages render (code, days as letters, start/end as HHMM).
function parseCoursePageHtml(html, crn) {
    const section = {
        crn: String(crn),
        code: '',
        title: '',
        credits: '',
        classSize: null,
        days: [],
        start: '',
        end: '',
        building: '',
        room: '',
        campus: '',
        instructor: '',
        prereqs: '',
        coreqs: '',
        equivalents: '',
    };

    // Title: og:title ("CS 501 (01) - Professional Ethics ...") or <title>.
    let title = String((html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || ['', ''])[1])
        || String((html.match(/<title>([\s\S]*?)<\/title>/i) || ['', ''])[1]);
    title = decodeEntities(title).replace(/\|\s*Course Search\s*$/i, '').trim();
    const tm = title.match(/^(.+?)\s+\((\d+)\)\s*-\s*(.+)$/);
    if (tm) {
        section.code = tm[1].replace(/\s+/g, ' ') + '-' + tm[2];
        section.title = tm[3];
    } else {
        section.title = title;
    }

    section.credits = textUntilTag(html, '<strong>Credits:</strong>');
    // Class Size sits inside a tooltip span: ...>22&nbsp;<i ...</span>
    const sizeAfter = String(html).slice(String(html).indexOf('<strong>Class Size:</strong>') + '<strong>Class Size:</strong>'.length);
    const sizeM = sizeAfter.match(/>([\d,]+)[^<>]{0,40}</);
    if (sizeM) section.classSize = parseInt(sizeM[1].replace(/,/g, ''), 10);

    const instrBlock = (html.match(/<b>Instructors:<\/b>([\s\S]{0,600}?)<\/div>/i) || ['', ''])[1];
    if (instrBlock) {
        const names = [];
        const aRe = /<a[^>]*href=["']mailto:[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
        let am;
        while ((am = aRe.exec(instrBlock)) !== null) names.push(decodeEntities(am[1]));
        if (names.length) {
            section.instructor = names.join(', ');
        } else {
            section.instructor = decodeEntities(instrBlock.replace(/<[^>]*>/g, ' ')).trim();
        }
    }

    const campusM = html.match(/\/timeroom\?campus=\d+"[^>]*>([\s\S]*?)<\/a>/i);
    if (campusM) section.campus = decodeEntities(campusM[1]);

    // Requirement blocks ("MATH 426 or MATH 426H" — spaces and "or"/"and"
    // tokens are meaningful, so keep the raw grouping instead of splitting).
    // Label variants cover the catalog's inconsistent casing across
    // departments (Prerequisite(s)/Pre-Requisite, Co-Requisite(s)/Corequisite,
    // with or without the "s").
    section.prereqs = requirementText(html, [
        '<b>Prerequisite(s):</b>', '<b>Prerequisite:</b>', '<b>Prerequisites:</b>',
        '<b>Pre-Requisite(s):</b>', '<b>Pre-Requisite:</b>', '<b>Pre-Requisites:</b>',
    ]);
    section.coreqs = requirementText(html, [
        '<b>Co-Requisite:</b>', '<b>Co-Requisites:</b>', '<b>Co-Requisite(s):</b>',
        '<b>Corequisite:</b>', '<b>Corequisites:</b>', '<b>Corequisite(s):</b>',
        '<b>Co-requisite:</b>', '<b>Co-requisites:</b>', '<b>Co-requisite(s):</b>',
    ]);
    section.equivalents = requirementText(html, ['<b>Equivalent(s):</b>', '<b>Equivalent:</b>']);

    // Times & Locations: rows of Start Date | End Date | Days | Time | Location
    const tableM = html.match(/Times\s*&amp;\s*Locations([\s\S]*?)<\/table>/i) || html.match(/Times\s*&\s*Locations([\s\S]*?)<\/table>/i);
    if (tableM) {
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        const rows = [];
        let rm;
        while ((rm = trRe.exec(tableM[1])) !== null) rows.push(rm[1]);
        // rows[0] is the header row; meeting rows start at index 1.
        let picked = false;
        for (let r = 1; r < rows.length && !picked; r++) {
            const cells = [];
            const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let cm;
            while ((cm = tdRe.exec(rows[r])) !== null) cells.push(decodeEntities(cm[1].replace(/<[^>]*>/g, ' ')));
            if (cells.length < 4) continue;
            const days = parseDaysStr(cells[2]);
            const tRange = parseCourseTimeRange(cells[3]);
            if (!days.length && !tRange) continue; // "TBA" / "Hours Arranged" row
            picked = true;
            section.days = days;
            const loc = (cells[4] || '').trim();
            const locM = loc.match(/^([A-Za-z]{2,6})\s+(.+)$/);
            if (locM) { section.building = locM[1]; section.room = locM[2]; }
            else { section.building = loc; }
            if (tRange) { section.start = tRange.start; section.end = tRange.end; }
        }
    }
    return section;
}

async function fetchCourseSection(termCode, crn) {
    const url = COURSES_BASE + '/class/' + encodeURIComponent(termCode) + '/' + encodeURIComponent(crn);
    const res = await fetch(url, { credentials: 'omit' });
    if (res.status === 404) {
        return { crn: String(crn), error: 'No section found for CRN ' + crn + ' in that term (' + termCode + ').' };
    }
    if (!res.ok) throw new Error('courses.unh.edu returned HTTP ' + res.status);
    const html = await res.text();
    if (/<title>\s*Page not found/i.test(html)) {
        return { crn: String(crn), error: 'No section found for CRN ' + crn + ' in that term (' + termCode + ').' };
    }
    return parseCoursePageHtml(html, crn);
}

// Does the public catalog have ANY sections for this term? The catalog lags
// WebCat, so a semester that isn't open yet (e.g. Fall 2027) comes back
// empty — call that out explicitly instead of reporting every CRN as
// "not found". Returns true/false, or null when the check itself failed.
async function termHasSections(termCode) {
    const cached = termAvailabilityCache.get(termCode);
    if (cached && Date.now() - cached.t < COURSE_PAGE_CACHE_MS) return cached.available;
    let available = null;
    try {
        const url = COURSES_BASE + '/jsonapi/node/course?filter%5Bfield_term_code%5D=' + encodeURIComponent(termCode) + '&page%5Blimit%5D=1';
        const res = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/vnd.api+json' } });
        if (res.ok) {
            const json = await res.json();
            available = !!(json && json.data && json.data.length);
        }
    } catch (e) {
        console.warn('[YACE] courses.unh.edu term availability check failed for ' + termCode + ':', e);
    }
    termAvailabilityCache.set(termCode, { t: Date.now(), available });
    return available;
}
const RMP_TEACHER_QUERY = `query TeacherSearch($query: TeacherSearchQuery!, $first: Int) {
  newSearch {
    teachers(query: $query, first: $first) {
      resultCount
      edges { node { id legacyId firstName lastName avgRatingRounded avgDifficultyRounded numRatings wouldTakeAgainPercentRounded wouldTakeAgainCount department teacherRatingTags { tagName tagCount } school { id legacyId name } } }
    }
  }
}`;

// --- Canvas file byte chase (FETCH_FILE) ---
// The dashboard's content script cannot follow Canvas's file-download
// redirects to the cross-origin file CDN (CORS blocks credentialed fetches in
// page contexts), but the background page has host permissions for the CDN and
// bypasses CORS. Mirrors the content-side chaser: raw PDF bytes, file JSON
// metadata (including {"attachment":{...}} records), and HTML verifier
// interstitials. Bytes come back as base64.

function bgLooksLikePdf(buf) {
    if (!buf || buf.byteLength < 5) return false;
    const head = new Uint8Array(buf.slice(0, 5));
    return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d; // %PDF-
}

function bgAppendVerifier(fileUrl, verifier) {
    if (!verifier) return fileUrl;
    return fileUrl + (fileUrl.indexOf('?') >= 0 ? '&' : '?') + 'verifier=' + encodeURIComponent(verifier);
}

function bgHeadString(buf, n) {
    if (!buf) return '';
    const bytes = new Uint8Array(buf.slice(0, n || 40));
    let out = '';
    for (const b of bytes) out += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
    return out;
}

// Pull the redirect target out of a Canvas verifier/interstitial HTML page:
// a <meta refresh>, a JS `location` assignment, or a post-back form carrying a
// hidden `verifier` input. Absolute URL or null.
function bgFindRedirectInHtml(html, baseUrl) {
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
        return abs(baseUrl.split('?')[0] + '?verifier=' + encodeURIComponent(v) + '&download_frd=1');
    }
    return null;
}

// With Total Cookie Protection a cookie can live in several partitions; the
// partition is a client-side storage detail — the server only validates the
// cookie VALUE. Duplicates in one Cookie header are a problem though (Rails
// reads only the first match), so for each cookie NAME we send exactly one
// value: the freshest (highest lastAccessed), preferring the unpartitioned
// first-party copy as a tie-breaker.
function bgCookieIsPartitioned(c) {
    if (c == null || c.partitionKey == null) return false;
    if (typeof c.partitionKey === 'string') {
        return c.partitionKey.length > 0 && c.partitionKey !== 'none';
    }
    return !!(c.partitionKey && c.partitionKey.topLevelSite);
}

function bgPickCookies(cookies) {
    const byName = new Map();
    for (const c of cookies) {
        const cur = byName.get(c.name);
        if (!cur) { byName.set(c.name, c); continue; }
        const curLast = cur.lastAccessed || 0;
        const cLast = c.lastAccessed || 0;
        if (cLast > curLast) byName.set(c.name, c);
        else if (cLast === curLast && bgCookieIsPartitioned(cur) && !bgCookieIsPartitioned(c)) byName.set(c.name, c);
    }
    return Array.from(byName.values());
}

const bgCookiesLoggedHosts = new Set();

// Read the current cookies for a URL as a "Cookie" header string. The
// background page is a cross-site (moz-extension://) origin, so a plain
// credentialed fetch doesn't see the user's SameSite / partitioned session
// cookies for Canvas; passing them explicitly re-authenticates the request.
// Returns { header, summary } or null. The content script is same-site with
// Canvas, so its own fetches never need this.
async function bgCookiesFor(url) {
    try {
        const host = new URL(url).host;
        const cookies = await browser.cookies.getAll({ url: url });
        if (!cookies || !cookies.length) return null;
        const picked = bgPickCookies(cookies);
        if (!picked.length) return null;
        const header = picked.map((c) => c.name + '=' + c.value).join('; ');
        const summary = picked.map((c) =>
            c.name + '[' + String(c.value || '').length + 'B' + (bgCookieIsPartitioned(c) ? ':p' : '') + ']'
        );
        if (!bgCookiesLoggedHosts.has(host)) {
            bgCookiesLoggedHosts.add(host);
            console.warn('[YACE] Cookies attached for ' + host + ': ' + summary.join(', '));
        }
        return { header, summary };
    } catch (e) {
        return null;
    }
}

const YACE_COOKIE_HOSTS = ['mycourses.unh.edu', 'unh.instructure.com'];

// Per-host cache of the Cookie header used by the manual-Cookie fallback in
// bgFetchBytes (a fetch-attached Cookie header is empirically delivered past
// the SSO gate; session-URL chasing rarely succeeds, but it's kept as a
// last-resort path). Refreshed on demand and on cookie changes.
const yaceCookieCache = new Map(); // host -> { header, summary }

// The CDN download token is SINGLE-USE ("JWT rejected: JTI has already been
// used"), so only ONE GET of a CDN URL can ever return bytes. Trick: let the
// PAGE generate the redirect (its real cookies make Canvas mint a fresh token),
// but CANCEL the page's CDN hop before it is transmitted — the token stays
// untouched. The background then fetches that exact URL itself and reads the
// bytes. Scoped: only CDN hops arriving shortly after one of OUR trigger
// requests (market ?yace=1 on the Canvas hop) are cancelled; other tabs' real
// downloads pass through untouched.
let yaceArmedAt = 0;        // when our trigger's Canvas hop was seen
let yaceCapturedUrl = null; // the untouched single-use CDN URL
let yaceCapturedAt = 0;     // when it was captured

browser.webRequest.onBeforeRequest.addListener((details) => {
    const u = details.url;
    // Our trigger request on the Canvas hop — arm the capture window.
    if (/(^|[?&])yace=1(&|$)/.test(u)) {
        yaceArmedAt = Date.now();
        return undefined;
    }
    // A CDN file hop while armed is our preview chain: cancel it untouched and
    // hand its (never-consumed) token URL to the FETCH_FILE handler.
    if (yaceArmedAt && (Date.now() - yaceArmedAt) < 5000
        && /\/files\//i.test(u) && /[?&]token=/i.test(u)
        && /inscloudgate\.net|instructuremedia\.com/i.test(u)) {
        yaceCapturedUrl = u;
        yaceCapturedAt = Date.now();
        yaceArmedAt = 0; // disarm after one capture
        return { cancel: true };
    }
    return undefined;
}, {
    urls: [
        'https://mycourses.unh.edu/*',
        'https://unh.instructure.com/*',
        '*://*.inscloudgate.net/*',
        '*://*.instructuremedia.com/*'
    ]
}, ['blocking']);

async function yaceRefreshCookieHost(host) {
    try {
        const cd = await bgCookiesFor('https://' + host + '/');
        if (cd) yaceCookieCache.set(host, cd);
        else yaceCookieCache.delete(host);
    } catch (e) { /* ignore */ }
}

async function yaceRefreshCookieCache(hosts) {
    for (const host of (hosts || YACE_COOKIE_HOSTS)) {
        await yaceRefreshCookieHost(host);
    }
}

browser.cookies.onChanged.addListener((changeInfo) => {
    const domain = (changeInfo && changeInfo.cookie && changeInfo.cookie.domain) || '';
    const host = domain.replace(/^\./, '');
    if (YACE_COOKIE_HOSTS.indexOf(host) >= 0) yaceRefreshCookieHost(host);
});

async function bgFetchBytes(url, headers, opts) {
    opts = opts || {};
    const h = Object.assign({}, headers || {});
    // Manual "Cookie" header — empirically delivered (a round with it attached
    // reached Canvas and got its 401, so it passed the SSO gate). Only hosts in
    // the cookie cache get it; CDN hosts stay clean (their token suffices).
    let credentials = 'include';
    let cookieSummary = null;
    if (!opts.noCookies) {
        try {
            const cd = yaceCookieCache.get(new URL(url).host);
            if (cd) {
                h['Cookie'] = cd.header;
                cookieSummary = cd.summary;
                credentials = 'omit';
            }
        } catch (e) { /* ignore */ }
    }
    try {
        const res = await fetch(url, { credentials: credentials, headers: h });
        const ab = await res.arrayBuffer();
        return {
            status: res.status,
            // response.url is the FINAL url after transparent redirects —
            // i.e. the CDN + token URL when Canvas 302s a download. Lets the
            // chase retry that hop cookieless (the token needs no session).
            finalUrl: res.url !== url ? res.url : undefined,
            buf: ab,
            cookieSummary: cookieSummary
        };
    } catch (e) {
        return { status: 0, buf: null, err: (e && e.message) ? String(e.message).slice(0, 120) : String(e), cookieSummary: cookieSummary };
    }
}

// Chase a Canvas file-ish URL until real PDF bytes come back: raw bytes, file
// JSON metadata -> follow its `url`, HTML interstitials -> follow the redirect.
async function bgChaseBytes(url, headers) {
    let cur = url;
    let status = 0;
    let lastBuf = null;
    let lastFinalUrl = null;
    let lastCookieSummary = null;
    for (let hop = 0; hop < 6; hop++) {
        const res = await bgFetchBytes(cur, headers);
        if (!res) return { status: 0, buf: null, err: 'no response' };
        status = res.status;
        if (res.err) return res;
        if (res.finalUrl) lastFinalUrl = res.finalUrl;
        if (res.cookieSummary) lastCookieSummary = res.cookieSummary;
        if (bgLooksLikePdf(res.buf)) return { status, buf: res.buf, finalUrl: res.finalUrl, cookieSummary: lastCookieSummary };
        if (!res.buf || res.buf.byteLength === 0) return { status, buf: null, finalUrl: res.finalUrl, cookieSummary: lastCookieSummary };
        lastBuf = res.buf;

        // The fetch followed a redirect (finalUrl set) but didn't land on PDF
        // bytes — likely the CDN rejected the forwarded Canvas cookies. Hit the
        // final URL again clean (the token in the URL is all the CDN needs).
        if (res.finalUrl && res.finalUrl !== cur) {
            const retry = await bgFetchBytes(res.finalUrl, headers, { noCookies: true });
            if (bgLooksLikePdf(retry.buf)) return { status: retry.status, buf: retry.buf, finalUrl: retry.finalUrl };
            if (retry.err) return retry;
            if (retry.status && retry.status !== status) status = retry.status;
            if (retry.buf && retry.buf.byteLength > 0) {
                res.buf = retry.buf;
                lastBuf = retry.buf;
            }
        }

        const first = new Uint8Array(res.buf.slice(0, 2));
        if (first[0] === 0x7b || first[0] === 0x5b) { // '{' or '[' -> JSON metadata
            let meta = null;
            try { meta = JSON.parse(new TextDecoder().decode(res.buf)); } catch (e) { meta = null; }
            const rec = (meta && meta.attachment) || meta;
            if (rec && typeof rec.url === 'string') {
                try {
                    const nextUrl = new URL(bgAppendVerifier(rec.url, rec.verifier), cur).href;
                    if (nextUrl !== cur) { cur = nextUrl; continue; }
                } catch (e) { /* fall through */ }
            }
            return { status, buf: res.buf, finalUrl: res.finalUrl, cookieSummary: lastCookieSummary };
        }

        const html = new TextDecoder().decode(res.buf).replace(/^\uFEFF/, '');
        if (!/<(?:html|!doctype|meta|script|form)\b/i.test(html.slice(0, 400))) {
            return { status, buf: res.buf, finalUrl: res.finalUrl, cookieSummary: lastCookieSummary };
        }
        const next = bgFindRedirectInHtml(html, cur);
        if (!next || next === cur) return { status, buf: res.buf, finalUrl: res.finalUrl, cookieSummary: lastCookieSummary };
        cur = next;
    }
    return { status, buf: lastBuf, finalUrl: lastFinalUrl, cookieSummary: lastCookieSummary };
}

function bgBufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// Join StreamFilter chunks (ArrayBuffers) into one buffer.
function bgJoinChunks(chunks) {
    if (!chunks || !chunks.length) return null;
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
        out.set(new Uint8Array(chunk), off);
        off += chunk.byteLength;
    }
    return out.buffer;
}

// FoodPro shortmenu.asp is slow and can hang. Primary attempt gets a generous
// deadline (FoodPro may legitimately need several seconds to render the menu);
// fallback variants race with a short deadline. A hop-level cache keyed by
// hall+day keeps repeat calls (view re-renders, day toggles, re-opens) off the
// slow site entirely.
const DINING_MENU_PRIMARY_MS = 8000;
const DINING_MENU_FALLBACK_MS = 2000;
const DINING_MENU_CACHE_MS = 20 * 60 * 1000;
const diningMenuCache = new Map(); // key: locationNum::dtdate -> { t, html }

browser.runtime.onMessage.addListener((request) => {
    if (request.type === 'FETCH_RMP') {
        return (async () => {
            try {
                const res = await fetch(RMP_GRAPHQL_URL, {
                    method: 'POST',
                    credentials: 'omit',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Basic dGVzdDp0ZXN0',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: JSON.stringify({
                        query: RMP_TEACHER_QUERY,
                        variables: {
                            query: { text: String(request.text || ''), schoolID: RMP_SCHOOL_ID, fallback: true },
                            first: 10
                        }
                    })
                });
                if (!res.ok) return { success: false, error: `Rate My Professor returned HTTP ${res.status}` };
                const json = await res.json();
                const edges = (((json.data || {}).newSearch || {}).teachers || {}).edges || [];
                return { success: true, teachers: edges.map(e => e.node) };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        })();
    }

    if (request.type === 'FETCH_DINING_HOURS') {
        return (async () => {
            try {
                const res = await fetch('https://www.unh.edu/dining/facilities/hours', { credentials: 'omit' });
                if (res.ok) {
                    const html = await res.text();
                    return { success: true, html };
                }
            } catch (e) {
                console.warn('[YACE] Failed to fetch live UNH hours:', e);
            }
            return { success: false };
        })();
    }

    if (request.type === 'FETCH_DINING_MENU') {
        return (async () => {
            const locationNum = request.locationNum || 80;
            const cleanLocName = encodeURIComponent((request.locationName || 'Holloway Commons').replace(/\+/g, ' '));
            // dtdate selects which day FoodPro serves (M/D/YYYY). Defaults to
            // today; pass request.dtdate to peek at another day's menu — the
            // site serves tomorrow's (and later) menus from the same URL.
            const dateObj = request.dtdate ? new Date(request.dtdate) : new Date();
            const dtdate = `${dateObj.getMonth() + 1}/${dateObj.getDate()}/${dateObj.getFullYear()}`;

            // Hop-level cache: repeated calls for the same hall+day (view
            // re-renders, day toggling, re-opens) skip FoodPro entirely.
            const cacheKey = locationNum + '::' + dtdate;
            const cached = diningMenuCache.get(cacheKey);
            if (cached && Date.now() - cached.t < DINING_MENU_CACHE_MS) {
                return { success: true, html: cached.html };
            }

            // FoodPro's shortmenu.asp is slow and can hang. Previously each of
            // four URL variants was tried sequentially with a 4s abort — worst
            // case ~16s per hall when the server stalled. Now the primary
            // (https + dtdate) gets one generous attempt, and only failures
            // race the remaining variants in parallel with a short deadline.
            const base = 'shortmenu.asp?sName=University+Of+New+Hampshire+Hospitality+Services&locationNum=' + locationNum + '&locationName=' + cleanLocName;
            const variants = [
                'https://foodpro.unh.edu/' + base + '&dtdate=' + encodeURIComponent(dtdate),
                'https://foodpro.unh.edu/' + base,
                'http://foodpro.unh.edu/' + base + '&dtdate=' + encodeURIComponent(dtdate),
                'http://foodpro.unh.edu/' + base
            ];

            const grab = async (url, ms) => {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), ms);
                    const res = await fetch(url, { signal: controller.signal, credentials: 'omit' });
                    clearTimeout(timer);
                    const html = await res.text();
                    // Return a record even for non-ok responses: any HTTP
                    // answer means the server is up (that day may genuinely
                    // have no menu), while an abort/throw means unreachable.
                    return {
                        ok: res.ok,
                        html: (html && html.includes('shortmenurecipes')) ? html : null,
                        responded: true
                    };
                } catch (e) {
                    return { ok: false, html: null, responded: false };
                }
            };

            const results = [];
            results.push(await grab(variants[0], DINING_MENU_PRIMARY_MS));
            if (!results[0].ok || !results[0].html) {
                results.push(...(await Promise.all(variants.slice(1).map(u => grab(u, DINING_MENU_FALLBACK_MS)))));
            }
            const winner = results.find(r => r.ok && r.html);
            if (winner) {
                diningMenuCache.set(cacheKey, { t: Date.now(), html: winner.html });
                return { success: true, html: winner.html };
            }
            // Distinguish an outage from "no menu posted": any HTTP response
            // at all means FoodPro answered, so the day is just empty.
            return { success: false, network: !results.some(r => r.responded) };
        })();
    }

    if (request.type === 'FETCH_UNH_CALENDAR') {
        // UNH's official academic calendar as an iCalendar feed. The registrar
        // page (www.unh.edu/registrar/calendar) embeds it as a 25Live/Trumba
        // "spud" that is rendered client-side, but the same calendar is
        // published as a static text/calendar feed — every entry is an all-day
        // VEVENT with SUMMARY/DTSTART/DTEND, so the content side can read the
        // raw ICS instead of scraping a JS widget. This is also where the
        // registrar posts holidays, breaks, reading days, schedule changes
        // and any weather/closure notice, so it is the live source for "days
        // off" (see services/calendar-api.js).
        return (async () => {
            try {
                const res = await fetch(UNH_ACADEMIC_CALENDAR_ICS, { credentials: 'omit' });
                if (!res.ok) return { success: false, error: 'UNH calendar feed returned HTTP ' + res.status };
                const ics = await res.text();
                // Guard against an HTML error page / interstitial served with a
                // 200 — the parser needs real VEVENT blocks.
                if (!ics.includes('BEGIN:VEVENT')) {
                    return { success: false, error: 'UNH calendar feed did not return an iCalendar document.' };
                }
                return { success: true, ics };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        })();
    }

    if (request.type === 'FETCH_WEBCAT_CRN') {
        return (async () => {
            try {
                const termLabel = String(request.term || '').trim();
                const crns = (request.crns || []).map(c => String(c).trim()).filter(Boolean).slice(0, 12);
                if (!crns.length) return { success: false, error: 'No CRNs to look up.' };
                // termCode may arrive straight from a course-search result
                // (already a UNH term code). When absent, map the saved
                // label to a term code via WebCat's public term list.
                const termCode = request.termCode || await getWebCatTermCode(termLabel);
                if (!request.termCode) {
                    const available = await termHasSections(termCode);
                    if (available === false) {
                        return {
                            success: false,
                            error: '\u201C' + termLabel + '\u201D (' + termCode + ') isn\u2019t available in the UNH course catalog yet \u2014 sections for that semester haven\u2019t been published on courses.unh.edu. Check that the saved term is a currently-open semester, then retry.',
                        };
                    }
                }
                const sections = [];
                for (const crn of crns) {
                    const cacheKey = termCode + '::' + crn;
                    const cached = coursePageCache.get(cacheKey);
                    if (cached && Date.now() - cached.t < COURSE_PAGE_CACHE_MS) {
                        sections.push(cached.section);
                        continue;
                    }
                    let section;
                    try {
                        section = await fetchCourseSection(termCode, crn);
                    } catch (e) {
                        console.warn('[YACE] courses.unh.edu lookup failed for ' + crn + ':', e);
                        section = { crn, error: 'Lookup failed (could not reach courses.unh.edu).' };
                    }
                    coursePageCache.set(cacheKey, { t: Date.now(), section });
                    sections.push(section);
                }
                return { success: true, termLabel, termCode, sections };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        })();
    }

    if (request.type === 'FETCH_COURSE_SEARCH') {
        // Full-text-ish search of the public catalog's course nodes by name
        // or code ("differential equations", "math 527", "CS 501"). Taps the
        // same Drupal JSON:API used elsewhere: CONTAINS on node titles, which
        // are "<CODE> (<sec>) - <Name>" and match case-insensitively. When a
        // term is provided it's filtered to that semester; otherwise every
        // published term comes back so the user sees all options.
        return (async () => {
            const query = String(request.query || '').trim();
            if (!query) return { success: false, error: 'Enter a course name or code to search.' };
            try {
                let termCode = null;
                if (request.termCode) {
                    termCode = String(request.termCode).trim() || null;
                } else if (request.term) {
                    termCode = await getWebCatTermCode(String(request.term).trim()).catch(() => null);
                }
                const url = COURSES_BASE + '/jsonapi/node/course?'
                    + 'filter%5Btitle%5D%5Boperator%5D=CONTAINS'
                    + '&filter%5Btitle%5D%5Bvalue%5D=' + encodeURIComponent(query)
                    + (termCode ? '&filter%5Bfield_term_code%5D=' + encodeURIComponent(termCode) : '')
                    + '&page%5Blimit%5D=50'
                    + '&fields%5Bnode--course%5D=title,field_crn,field_term_code,path';
                const res = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/vnd.api+json' } });
                if (!res.ok) return { success: false, error: 'courses.unh.edu search returned HTTP ' + res.status };
                const json = await res.json();
                const nodes = (json && json.data) || [];
                const matches = [];
                for (const n of nodes) {
                    const attrs = (n && n.attributes) || {};
                    const title = String(attrs.title || '').trim();
                    const crn = String(attrs.field_crn != null ? attrs.field_crn : '').trim();
                    if (!title || !crn) continue;
                    const tCode = String(attrs.field_term_code != null ? attrs.field_term_code : '').trim();
                    matches.push({
                        title,
                        crn,
                        termCode: tCode,
                        termLabel: termCodeToLabel(tCode),
                        path: String(((n && n.path) || {}).alias || '').trim(),
                    });
                }
                return { success: true, matches, termCode, filtered: !!termCode };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        })();
    }

    if (request.type === 'FETCH_FILE') {
        // Fetch Canvas file bytes from the background page. Content-script
        // fetch() cannot follow the download redirect to the cross-origin file
        // CDN (CORS), but the background page has host permissions for the CDN
        // and bypasses CORS. Chases each URL for raw PDF bytes (see
        // bgChaseBytes) and returns the first hit base64-encoded.
        return (async () => {
            await yaceRefreshCookieCache().catch(() => {});
            const urls = (request.urls || []).slice();

            const safeHeaders = request.headers ? {
                'X-Requested-With': request.headers['X-Requested-With'],
                'X-CSRF-Token': request.headers['X-CSRF-Token'],
                'Accept': request.headers['Accept']
            } : undefined;

            // Our trigger armed the capture and a single-use CDN URL was
            // cancelled before it was transmitted; the token is untouched, so
            // fetch it directly — this is the one GET that can read the bytes.
            const captured = yaceCapturedUrl
                && yaceCapturedAt >= (request.previewAt || 0)
                && (Date.now() - yaceCapturedAt) < 15000
                    ? { url: yaceCapturedUrl }
                    : null;
            let capBytes = -1;
            if (captured) {
                const got = await bgFetchBytes(captured.url, safeHeaders, { noCookies: true });
                if (bgLooksLikePdf(got.buf)) {
                    return { success: true, origin: captured.url, bytesBase64: bgBufToBase64(got.buf) };
                }
                capBytes = got.buf ? got.buf.byteLength : -1;
            }

            const results = [];
            for (const url of urls) {
                const got = await bgChaseBytes(url, safeHeaders);
                if (bgLooksLikePdf(got.buf)) {
                    return { success: true, origin: url, bytesBase64: bgBufToBase64(got.buf) };
                }
                results.push({
                    url,
                    status: got.status,
                    err: got.err,
                    final: got.finalUrl,
                    head: bgHeadString(got.buf, 200).slice(0, 200)
                });
            }
            // Report which cookies were attached (names + value sizes + whether
            // the win came from a partitioned copy) so auth failures are
            // debuggable from the page console.
            let cookieSummary = null;
            try {
                const firstUrl = (request.urls || [])[0];
                if (firstUrl) {
                    const cd = await bgCookiesFor(firstUrl);
                    if (cd) cookieSummary = cd.summary.join(', ');
                }
            } catch (e) { /* non-fatal */ }
            return { success: false, results, cookies: cookieSummary, capBytes: capBytes };
        })();
    }
});
