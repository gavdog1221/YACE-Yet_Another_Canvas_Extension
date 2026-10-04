// Building hours — STATIC.
//
// This data used to be scraped live from three UNH sites on every visit to the
// Hours tab. That was a lot of work for a table that changes twice a semester,
// so the hours are now bundled here as plain constants. Nothing in this module
// touches the network, the background script, or storage — openHours() is a
// pure synchronous call, so the tab paints with zero fetches.
//
// Verified against the live sources on 2026-10-04 (Fall 2026 semester):
//   - MUB   www.unh.edu/mub/about/mub-building-hours
//   - Hamel campusrec.unh.edu/hours
//   - Libs  librarycalendars.unh.edu LibCal hours grid (iid=3647)
//
// Each card links out to its live source, because UNH DOES change these for
// breaks, finals and holidays (the MUB alone has a separate "Finals Week and
// Winter Break" schedule) — this snapshot is the common-case schedule only.
// When you spot a change, edit the table below; nothing else needs to move.

// Day indexes match Date#getDay(): 0 = Sunday.
const DAY_IDX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// "7:00 am" | "7am" | "12pm" -> { disp, min }
function toMin(raw) {
  const m = String(raw).trim().replace(/\./g, '').toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

// "Monday - Friday" | "Saturday & Sunday" -> day indexes.
function days(label) {
  const parts = String(label).split(/\s*(?:-|&|–)\s*/)
    .map(p => DAY_IDX[p.trim().toLowerCase()])
    .filter(d => d !== undefined);
  if (!parts.length) return [];
  if (parts.length === 1) return parts;
  const out = [];
  for (let i = parts[0], n = 0; n < 7; n++) {
    out.push(i);
    if (i === parts[parts.length - 1]) break;
    i = (i + 1) % 7;
  }
  return out;
}

// One row: an open span, or `null` for a closed day.
function row(label, open) {
  const d = days(label);
  if (!open) return { label, days: d, closed: true, spans: [], raw: 'Closed' };
  const [from, to] = open;
  const startMin = toMin(from);
  const endMin = toMin(to);
  return {
    label,
    days: d,
    closed: false,
    spans: [{
      startMin,
      endMin,
      startDisp: from.toUpperCase().replace(/\s+/g, ' '),
      endDisp: to.toUpperCase().replace(/\s+/g, ' '),
    }],
    raw: from + ' - ' + to,
  };
}

// --- MUB (www.unh.edu/mub/about/mub-building-hours) -------------------------
// The building's own posted hours, plus the two department offices that keep
// their own schedules inside the MUB.
const MUB = {
  name: 'Memorial Union Building (MUB)',
  icon: '🏛️',
  link: 'https://www.unh.edu/mub/about/mub-building-hours',
  sections: [
    {
      name: 'Fall Semester Hours',
      rows: [
        row('Monday - Friday', ['7:00am', '11:00pm']),
        row('Saturday', ['10:00am', '11:00pm']),
        row('Sunday', ['2:00pm', '11:00pm']),
      ],
    },
    {
      name: 'Memorial Union Office',
      rows: [
        row('Monday - Friday', ['9am', '5pm']),
        row('Saturday & Sunday', null),
      ],
    },
    {
      name: 'Finals Week & Winter Break',
      rows: [
        row('Monday - Friday', ['10am', '4pm']),
        row('Saturday & Sunday', null),
      ],
    },
  ],
};

// --- Hamel Recreation Center (campusrec.unh.edu/hours) ----------------------
const HAMEL_REC = {
  name: 'Hamel Recreation Center',
  icon: '🏋️',
  link: 'https://campusrec.unh.edu/hours',
  sections: [
    {
      name: 'Fall Semester Hours',
      rows: [
        row('Monday - Thursday', ['6:00am', '11:00pm']),
        row('Friday', ['6:00am', '9:00pm']),
        row('Saturday', ['8:00am', '9:00pm']),
        row('Sunday', ['8:00am', '11:00pm']),
      ],
    },
  ],
};

// --- Libraries (LibCal grid, iid=3647) -------------------------------------
// Dimond and Kingsbury share one LibCal widget; the Manchester, Physics,
// Special Collections and Information Desk entries are either off-campus or
// appointment-only, so only the two Durham locations get a card.
const DIMOND = {
  name: 'Dimond Library',
  icon: '📚',
  link: 'https://library.unh.edu/about-us/hours',
  sections: [
    {
      name: 'Weekly Hours',
      rows: [
        row('Sunday', ['12pm', '8pm']),
        row('Monday', ['7:30am', '11pm']),
        row('Tuesday', ['7:30am', '11pm']),
        row('Wednesday', ['7:30am', '11pm']),
        row('Thursday', ['7:30am', '11pm']),
        row('Friday', ['7:30am', '6pm']),
        row('Saturday', ['10am', '6pm']),
      ],
    },
  ],
};

const KINGSBURY = {
  name: 'Kingsbury Library',
  icon: '📚',
  link: 'https://library.unh.edu/locations/engineering-math-cs-library',
  sections: [
    {
      name: 'Weekly Hours',
      rows: [
        row('Sunday', ['1pm', '6pm']),
        row('Monday', ['8am', '8pm']),
        row('Tuesday', ['8am', '8pm']),
        row('Wednesday', ['8am', '8pm']),
        row('Thursday', ['8am', '8pm']),
        row('Friday', ['8am', '4pm']),
        row('Saturday', null),
      ],
    },
  ],
};

// Order matters for computeBuildingStatus(): it reads the LAST section whose
// rows match today, so the more specific schedule wins.
export const BUILDINGS = [MUB, HAMEL_REC, DIMOND, KINGSBURY];

// Synchronous, allocation-light: the view calls this once per open.
export function openHours() {
  return BUILDINGS;
}

// Open/closed status for *right now*, from whichever row covers the current
// weekday. The last match wins, so a semester-specific block (finals/weekend
// schedule) overrides the generic one for the same day.
export function computeBuildingStatus(b, now = new Date()) {
  const dayIdx = now.getDay();
  const curMin = now.getHours() * 60 + now.getMinutes();

  let todayRow = null;
  (b.sections || []).some(section => {
    const hits = (section.rows || []).filter(r => r.days.indexOf(dayIdx) !== -1);
    if (hits.length) {
      todayRow = hits[hits.length - 1];
      return true;
    }
    return false;
  });

  if (!todayRow || todayRow.closed || !todayRow.spans.length) {
    return { isOpen: false, label: 'Closed today' };
  }
  const inSpan = todayRow.spans.find(sp => curMin >= sp.startMin && curMin < sp.endMin);
  if (inSpan) {
    return { isOpen: true, label: `Open now · until ${inSpan.endDisp}` };
  }
  const nextOpen = todayRow.spans.map(sp => sp.startMin).filter(m => m > curMin).sort((a, b) => a - b)[0];
  if (nextOpen !== undefined) {
    const h = Math.floor(nextOpen / 60);
    const m = nextOpen % 60;
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { isOpen: false, label: `Opens ${h12}:${String(m).padStart(2, '0')} ${period}` };
  }
  return { isOpen: false, label: 'Closed for today' };
}