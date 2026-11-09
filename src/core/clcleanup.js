'use strict';
// Hardware version (CL) clean-up. CL1, CL2, CL3 are separate device models (a physical
// change to the hardware). A name without CL is the only version there is, until a CL2
// arrives; from then on the first version is written as CL1. PCI, L1 Contact and L2 Contact
// belong to the device itself and are shared by all its versions; L1 Contactless, TQM and
// L2 Contactless belong to one version.
//
// plan() lists the renames (and merges, where the renamed record would land on one that is
// already there) that bring the register in line with those rules. Nothing is changed by it.

const { splitVariant, SHARED_CATEGORIES, VERSION_CATEGORIES, baseDisplayName } = require('./devices');

const slot = (r, device, norm) => [norm(device), r.category, r.scheme || '', String(r.platform || '').toLowerCase(), String(r.bundle || '').toLowerCase()].join('|');

function plan(records, norm) {
  const live = records.filter((r) => !r.archived);
  const byBase = new Map();
  for (const r of live) {
    const { base } = splitVariant(norm(r.device));
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r);
  }
  const bySlot = new Map(live.map((r) => [slot(r, r.device, norm), r]));
  const items = [];
  for (const list of byBase.values()) {
    const variants = list.map((r) => splitVariant(norm(r.device)).variant);
    const later = variants.some((v) => /^CL[2-9]/.test(v));
    const named1 = variants.includes('CL1');
    // Write new names the way this device's versions are already written ("DX8000-CL2", "Lane/3000 CL2").
    const sample = list.find((r) => /CL\d\s*$/i.test(r.device));
    const sep = sample ? (sample.device.match(/([\s\-_]?)CL\d\s*$/i) || ['', '-'])[1] : '-';
    for (const r of list) {
      const v = splitVariant(norm(r.device)).variant;
      const base = baseDisplayName(r.device);
      let to = '', why = '';
      if (VERSION_CATEGORIES.has(r.category) && !v && (later || named1)) {
        to = `${base}${sep}CL1`;
        why = later ? 'A CL2 or later exists, so the first version is CL1' : `Other ${base} records already say CL1`;
      } else if (SHARED_CATEGORIES.has(r.category) && /^CL\d/.test(v)) {
        to = base;
        why = `${r.category} belongs to the device and is shared by all its hardware versions`;
      }
      if (!to || to === r.device) continue;
      const clash = bySlot.get(slot(r, to, norm));
      items.push({
        id: r.id, from: r.device, to, why, category: r.category, scheme: r.scheme || '', platform: r.platform || '', bundle: r.bundle || '',
        expiry_date: r.expiry_date || '', action: clash && clash.id !== r.id ? 'merge' : 'rename',
        into: clash && clash.id !== r.id ? { id: clash.id, device: clash.device, expiry_date: clash.expiry_date || '', approval_number: clash.approval_number || '' } : null,
      });
    }
  }
  return items.sort((a, b) => a.from.localeCompare(b.from, undefined, { numeric: true }) || a.category.localeCompare(b.category) || a.scheme.localeCompare(b.scheme));
}

module.exports = { plan };
