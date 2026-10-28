'use strict';
const { daysBetween, todayIso } = require('./dates');
const { MANUAL_STAGES } = require('./taxonomy');

// Expiration windows, inclusive. Order matters: the first match wins.
const WINDOWS = [
  { key: 'expired', label: 'Expired', test: (d) => d < 0 },
  { key: 'd30', label: '0–30 days', test: (d) => d <= 30 },
  { key: 'd60', label: '31–60 days', test: (d) => d <= 60 },
  { key: 'd90', label: '61–90 days', test: (d) => d <= 90 },
  { key: 'd180', label: '91–180 days', test: (d) => d <= 180 },
  { key: 'd365', label: '181–365 days', test: (d) => d <= 365 },
  { key: 'd545', label: '12–18 months', test: (d) => d <= 545 },
  { key: 'later', label: 'Over 18 months', test: () => true },
];

function windowFor(days) {
  if (days == null) return { key: 'missing', label: 'Missing date' };
  return WINDOWS.find((w) => w.test(days));
}

/** Days remaining until the record's effective expiration, relative to asOf. */
function daysRemaining(record, asOf = todayIso()) {
  const exp = effectiveExpiry(record);
  return exp ? daysBetween(asOf, exp) : null;
}

/**
 * The controlling expiration: the current approval's date. A replacement only
 * extends coverage once it has been verified (activated) - until then the
 * old date still governs, per the R6 rule that replacement values never
 * silently become current.
 */
function effectiveExpiry(record) {
  return record.expiry_date || null;
}

function recommendedStage(days) {
  if (days == null) return 'Monitoring';
  if (days < 0) return 'Expired';
  if (days <= 30) return '30 Day Escalation';
  if (days <= 60) return '60 Day Action';
  if (days <= 90) return '90 Day Planning';
  if (days <= 180) return '180 Day Planning';
  return 'Monitoring';
}

/**
 * A certification someone decided not to renew: its expiry is accepted (end of
 * life, e.g. the CL1 reader replaced by CL2). It stops raising actions and
 * stops counting as a gap or a risk.
 */
function isEol(record) { return !!String(record.eol || '').trim(); }

/** Stage shown to the user: a manual stage sticks, otherwise it is calculated. */
function effectiveStage(record, asOf) {
  if (isEol(record)) return 'Retired';
  if (record.stage && MANUAL_STAGES.has(record.stage)) return record.stage;
  return recommendedStage(daysRemaining(record, asOf));
}

/**
 * Coverage between the current approval and its replacement.
 * overlap = current expiry - replacement effective + 1 (inclusive days).
 * Positive = concurrent coverage, negative = gap.
 */
function coverage(currentExpiry, replacementEffective) {
  if (!currentExpiry || !replacementEffective) return null;
  const v = daysBetween(replacementEffective, currentExpiry) + 1;
  return v >= 0 ? { kind: 'overlap', days: v } : { kind: 'gap', days: -v };
}

function health(record, asOf) {
  const days = daysRemaining(record, asOf);
  const stage = effectiveStage(record, asOf);
  if (record.archived || isEol(record)) return 'retired';
  if (days == null) return 'unknown';
  if (days < 0) {
    if (stage === 'Market Approved Expiration' || stage === 'Retired') return 'retired';
    return 'expired';
  }
  if (days <= 90) return 'critical';
  if (days <= 365) return 'warning';
  return 'good';
}

module.exports = {
  WINDOWS, windowFor, daysRemaining, effectiveExpiry, recommendedStage,
  effectiveStage, coverage, health, isEol,
};
