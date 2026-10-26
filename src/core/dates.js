'use strict';
// Date helpers. All business dates are stored as ISO "YYYY-MM-DD" strings and
// compared as UTC calendar days so results never drift with the PC timezone.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function pad(n) { return String(n).padStart(2, '0'); }

function valid(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y) {
  y = Number(y);
  if (y < 100) return y + 2000;
  return y;
}

// Patterns tried in order. Each returns ISO or null.
const PATTERNS = [
  // 2027-04-27, 2024/11/01, 2024.12.23
  [/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/i, (m) => valid(+m[1], +m[2], +m[3])],
  // May 22, 2024 | August 20th, 2027 | Feb. 7 2028
  [new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
    (m) => valid(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2])],
  // 5 June 2024 | 1st February 2027 | 01 Feb. 2027 | 27-Apr-2027 | 3 Feb 2025
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+${MONTH_RE}\\.?[\\s-]+(\\d{2,4})\\b`, 'i'),
    (m) => valid(fullYear(m[3]), MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1])],
  // US numeric 04/30/26 or 04/30/2026
  [/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/, (m) => valid(fullYear(m[3]), +m[1], +m[2])],
];

/** Parse the first date found in a string. Returns ISO string or null. */
function parseDate(input) {
  if (input == null) return null;
  if (input instanceof Date && !isNaN(input)) {
    return valid(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate());
  }
  if (typeof input === 'number') {
    // Excel serial date
    if (input > 20000 && input < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + input * 86400000);
      return parseDate(dt);
    }
    return null;
  }
  const s = String(input).trim();
  if (!s) return null;
  for (const [re, fn] of PATTERNS) {
    const m = s.match(re);
    if (m) {
      const iso = fn(m);
      if (iso) return iso;
    }
  }
  return null;
}

/** Find every date in a block of text with its character offset. */
function findDates(text) {
  const out = [];
  if (!text) return out;
  for (const [re, fn] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      const iso = fn(m);
      if (iso && !out.some((o) => m.index < o.index + o.raw.length && o.index < m.index + m[0].length)) {
        out.push({ iso, index: m.index, raw: m[0] });
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function todayIso(now = new Date()) {
  // Local calendar day of the user, expressed as ISO.
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from `from` to `to` (to - from). */
function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

function addDays(iso, n) {
  const dt = new Date(toUtc(iso) + n * 86400000);
  return valid(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addYears(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  // Clamp Feb 29 to Feb 28 on non-leap targets.
  return valid(y + n, m, d) || valid(y + n, m, d - 1);
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  for (let dd = d; dd >= 28; dd--) { const v = valid(ny, nm, dd); if (v) return v; }
  return valid(ny, nm, Math.min(d, 28));
}

function formatDate(iso, style = 'medium') {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (style === 'short') return `${pad(m)}/${pad(d)}/${String(y).slice(2)}`;
  return `${names[m - 1]} ${d}, ${y}`;
}

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function wordToNumber(w) {
  if (w == null) return null;
  const n = Number(w);
  if (!isNaN(n)) return n;
  return WORD_NUMBERS[String(w).toLowerCase()] || null;
}

module.exports = {
  parseDate, findDates, todayIso, daysBetween, addDays, addYears, addMonths,
  formatDate, wordToNumber, MONTH_RE,
};
