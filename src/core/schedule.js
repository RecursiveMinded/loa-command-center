'use strict';
// When is the next digest notification due? Pure functions so the rule is
// testable without Electron. Times are local wall-clock time.

function parseTime(hhmm) {
  const m = String(hhmm || '08:30').match(/^(\d{1,2}):(\d{2})$/);
  return m ? [Math.min(23, +m[1]), Math.min(59, +m[2])] : [8, 30];
}

/** The most recent scheduled moment at or before `now`. */
function lastSlot(cfg, now = new Date()) {
  const [h, mi] = parseTime(cfg.time);
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(h, mi);
  if (cfg.frequency === 'daily') {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  if (cfg.frequency === 'weekly') {
    const wd = Number(cfg.weekday ?? 1); // 0 = Sunday
    const diff = (d.getDay() - wd + 7) % 7;
    d.setDate(d.getDate() - diff);
    if (d > now) d.setDate(d.getDate() - 7);
    return d;
  }
  if (cfg.frequency === 'monthly') {
    const md = Math.min(28, Math.max(1, Number(cfg.monthday ?? 1)));
    d.setDate(md);
    if (d > now) d.setMonth(d.getMonth() - 1);
    return d;
  }
  return null;
}

function nextSlot(cfg, now = new Date()) {
  const last = lastSlot(cfg, now);
  if (!last) return null;
  const n = new Date(last);
  if (cfg.frequency === 'daily') n.setDate(n.getDate() + 1);
  else if (cfg.frequency === 'weekly') n.setDate(n.getDate() + 7);
  else n.setMonth(n.getMonth() + 1);
  return n;
}

/**
 * True when a slot has passed since the last notification. A slot missed
 * while the PC was off fires once at next start-up, not once per missed slot.
 */
function isDue(cfg, now = new Date()) {
  if (!cfg || !cfg.enabled || !['daily', 'weekly', 'monthly'].includes(cfg.frequency)) return false;
  const last = lastSlot(cfg, now);
  if (!last) return false;
  const sent = cfg.lastSent ? new Date(cfg.lastSent) : null;
  return !sent || sent < last;
}

module.exports = { isDue, lastSlot, nextSlot, parseTime };
