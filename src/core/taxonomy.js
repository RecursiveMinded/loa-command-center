'use strict';
// Vendor-neutral vocabulary used across the app. Kept in one place so the UI,
// parser, importer, and rules engine agree on spelling.

const CATEGORIES = [
  'EMV L1 Contact',
  'EMV L1 Contactless',
  'EMV L2 Contact',
  'EMV L2 Contactless',
  'PCI PTS',
  'TQM',
  'Letter of Equivalency',
  'Other',
];

// Card brands and approval bodies.
const SCHEMES = [
  'EMVCo', 'Visa', 'Mastercard', 'Amex', 'Discover', 'UnionPay', 'JCB', 'Interac',
  'eftpos', 'CPACE', 'PCI SSC', 'Mastercard TQM', 'Other',
];

const SCHEME_ALIASES = [
  [/american\s*express|amex|expresspay/i, 'Amex'],
  [/discover|d-?pas|diners/i, 'Discover'],
  [/master\s*card|paypass|\bmc\b|m\/chip/i, 'Mastercard'],
  [/\bvisa\b|paywave|vcps/i, 'Visa'],
  [/union\s*pay|\bupi\b|\bcup\b|quick\s*pa(ss|y)/i, 'UnionPay'],
  [/\bjcb\b|j\/speedy/i, 'JCB'],
  [/interac|flash/i, 'Interac'],
  [/eftpos/i, 'eftpos'],
  [/cpace/i, 'CPACE'],
  [/emvco/i, 'EMVCo'],
  [/\bpci\b|pts/i, 'PCI SSC'],
  [/\btqm\b/i, 'Mastercard TQM'],
];

function normalizeScheme(s) {
  if (!s) return '';
  const str = String(s).trim();
  const exact = SCHEMES.find((x) => x.toLowerCase() === str.toLowerCase());
  if (exact) return exact;
  for (const [re, name] of SCHEME_ALIASES) if (re.test(str)) return name;
  return str;
}

function normalizeCategory(s) {
  if (!s) return '';
  const str = String(s).toLowerCase();
  const exact = CATEGORIES.find((x) => x.toLowerCase() === str);
  if (exact) return exact;
  if (/pci|pts/.test(str)) return 'PCI PTS';
  if (/tqm/.test(str)) return 'TQM';
  if (/equivalen/.test(str)) return 'Letter of Equivalency';
  const l2 = /\bl\s*2\b|level\s*2|kernel/.test(str);
  const l1 = /\bl\s*1\b|level\s*1|interface|bulletin/.test(str);
  const cless = /contactless|cless|\bctls\b|\bcl\b|proximity|pcd/.test(str);
  const contact = /contact/.test(str) && !cless;
  if (l2 && cless) return 'EMV L2 Contactless';
  // EMVCo L2 contact kernel approval (one per terminal, not per brand).
  if (l2 && contact) return 'EMV L2 Contact';
  if (l1 && cless) return 'EMV L1 Contactless';
  if (l1 && contact) return 'EMV L1 Contact';
  if (cless) return l2 ? 'EMV L2 Contactless' : 'EMV L1 Contactless';
  if (contact) return 'EMV L1 Contact';
  return s;
}

// Workflow stage: where the renewal effort is. Some are calculated, others set by a person.
const STAGES = [
  'Monitoring',
  '180 Day Planning',
  '90 Day Planning',
  '60 Day Action',
  '30 Day Escalation',
  'Renewal Requested',
  'Pending New LOA',
  'Replacement Received',
  'Certified',
  'Restricted Extension',
  'Market Approved Expiration',
  'Expired',
  'Retired',
];
const MANUAL_STAGES = new Set([
  'Renewal Requested', 'Pending New LOA', 'Replacement Received', 'Certified',
  'Restricted Extension', 'Market Approved Expiration', 'Retired',
]);

const DISPOSITIONS = [
  'Decision Required',
  'Renew',
  'Replace or Supersede',
  'Restricted One-Time Extension',
  'Market Approved Expiration',
  'No Action Required',
];

// How a certification will be renewed (from the industry's change classes).
const RENEWAL_PATHS = [
  'Administrative renewal',
  'Derivative / family',
  'Delta testing',
  'Full recertification',
];

const PORTAL_STATUSES = ['Not Tracked', 'In Sync', 'Change Needed', 'Change Requested', 'Published'];

module.exports = {
  CATEGORIES, SCHEMES, STAGES, MANUAL_STAGES, DISPOSITIONS, PORTAL_STATUSES, RENEWAL_PATHS,
  normalizeScheme, normalizeCategory,
};
