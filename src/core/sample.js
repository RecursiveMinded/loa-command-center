'use strict';
// Fictional demo portfolio so a new user (or a sales demo) can try every
// screen before loading real data. Device and platform names are invented.

const { addDays, todayIso } = require('./dates');

function sampleRecords(asOf = todayIso()) {
  const d = (n) => addDays(asOf, n);
  const devices = ['T100', 'T200', 'T300', 'P400', 'K500'];
  const brands = ['Visa', 'Mastercard', 'Amex', 'Discover', 'UnionPay', 'JCB', 'Interac'];
  const out = [];
  let k = 0;
  for (const [pi, platform] of ['Platform A', 'Platform B'].entries()) {
    for (const [di, dev] of devices.entries()) {
      const cl = `${dev}-CL1`;
      out.push({ platform, bundle: 'Bundle 3', device: dev, category: 'PCI PTS', scheme: 'PCI SSC', kernel_version: 'v6', expiry_date: d(900 + di * 40), approval_number: `4-${30100 + k++}` });
      out.push({ platform, bundle: 'Bundle 3', device: dev, category: 'EMV L1 Contact', scheme: 'EMVCo', expiry_date: d([-20, 45, 300, 700, 1200][(di + pi) % 5]), approval_number: `1${8000 + k++} 0624 430 43a 43a LAB` });
      out.push({ platform, bundle: 'Bundle 3', device: cl, category: 'EMV L1 Contactless', scheme: 'EMVCo', expiry_date: d([150, 400, 800, 25, 1000][(di + pi) % 5]), approval_number: `1${8900 + k++} 0624 310 31a 31a LAB`, restricted: di === 3 });
      out.push({ platform, bundle: 'Bundle 3', device: cl, category: 'TQM', scheme: 'Mastercard TQM', kernel_version: 'Contactless (PCD)', expiry_date: d(98) });
      for (const [bi, b] of brands.entries()) {
        if ((di + bi + pi) % 9 === 8) continue; // a few approvals not available
        const base = { Amex: 300, JCB: 183, Interac: 330, Visa: 1000, Mastercard: 600, Discover: 460, UnionPay: 250 }[b];
        out.push({
          platform, bundle: 'Bundle 3', device: cl, category: 'EMV L2 Contactless', scheme: b,
          expiry_date: b === 'Amex' || b === 'JCB' ? d(base) : d(base + ((di * 37 + bi * 11 + pi * 5) % 200) - 60),
          approval_number: `${b.slice(0, 3).toUpperCase()}-${2400 + k++}`,
          owner: (di + bi) % 3 === 0 ? ['Alex', 'Sam', 'Jordan'][bi % 3] : '',
        });
      }
    }
    out.push({ platform, bundle: 'Bundle 3', device: 'Kernel family', category: 'EMV L2 Contact', scheme: 'EMVCo', kernel_version: '9.06', expiry_date: d(430) });
  }
  // A few records with data gaps, to show the data-quality actions.
  out.push({ platform: 'Platform B', bundle: 'Bundle 2', device: 'T100-CL1', category: 'EMV L2 Contactless', scheme: 'Visa', expiry_date: null });
  out.push({ platform: 'Platform B', bundle: 'Bundle 2', device: 'T200-CL1', category: 'EMV L2 Contactless', scheme: 'Mastercard', expiry_date: d(-200), disposition: 'Market Approved Expiration', stage: 'Market Approved Expiration', notes: 'Market sunset approved; no renewal planned.' });
  return out;
}

module.exports = { sampleRecords };
