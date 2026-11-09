'use strict';
// Finding an L2 letter's kernel when the text reader did not: from labels the person has
// taught (by entering a kernel the letter prints), then from the file name
// ("DX8000CL1_MC_0403_0203.pdf"), preferring a number that a bundle runs for the brand.

const { kernelIds } = require('./bundles');

/** Kernel versions any bundle runs for this letter's brand (the EMV contact kernel for L2 Contact). */
function brandKernels(pages, L) {
  const out = new Set();
  for (const pg of Object.values(pages || {})) {
    const ctx = pg.ctx || {};
    if (L.category === 'EMV L2 Contact') { if (ctx.l2Contact) out.add(ctx.l2Contact); continue; }
    const k = (ctx.kernels || {})[L.scheme];
    if (k) out.add(k);
  }
  return [...out];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN = '([A-Za-z]{0,6}[ \\t]?v?\\d[\\w.\\-]{1,24})';

/** The kernel after a label the person taught, or null. labels: [{ label, scheme? }] */
function fromLearned(text, L, labels = []) {
  for (const x of labels) {
    if (x.scheme && L.scheme && x.scheme !== L.scheme) continue;
    const m = String(text || '').match(new RegExp(`${esc(x.label).replace(/\s+/g, '\\s+')}[\\s:#.\\-]*${TOKEN}`, 'i'));
    if (m) return { value: m[1].trim(), evidence: `After "${x.label}" (a label you taught)`, confidence: 0.85, source: 'learned' };
  }
  return null;
}

/** The kernel in a file name, or null. Numbers a bundle runs for the brand win. */
function fromFilename(filename, L, known = []) {
  const parts = String(filename || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').split(/[\s_]+/);
  // Device and type parts carry letters (DX8000CL1, MC, EmvL1Cless); kernel parts are numbers (0403, 02.03, v1.6).
  const nums = parts.filter((p) => /^v?\d[\d.]*$/i.test(p) && p.replace(/\D/g, '').length >= 3);
  if (!nums.length) return null;
  const hit = nums.find((p) => known.some((k) => kernelIds(k).some((id) => kernelIds(p).includes(id))));
  if (hit) return { value: hit, evidence: `From the file name "${filename}" (a bundle runs ${hit} for ${L.scheme || 'this brand'})`, confidence: 0.8, source: 'filename' };
  return { value: nums[0], evidence: `From the file name "${filename}"; no bundle you track runs it, so check it`, confidence: 0.5, source: 'filename' };
}

/** Fill L.kernelVersion on L2 letters that lack it. Returns true when one was set. */
function findKernel(L, { filename = '', text = '', pages = {}, labels = [] } = {}) {
  if (!L || L.informational || !/^EMV L2/.test(L.category || '') || (L.kernelVersion && L.kernelVersion.value)) return false;
  const k = fromLearned(text, L, labels) || fromFilename(filename, L, brandKernels(pages, L));
  if (!k) return false;
  L.kernelVersion = k;
  L.warnings = (L.warnings || []).filter((w) => !/^No kernel/i.test(w));
  if (k.source === 'filename') L.warnings.push(`Kernel ${k.value} taken from the file name; the letter text did not say. Check it on the LOA.`);
  return true;
}

/**
 * Learn where a kernel is printed: the words just before it on its line in the letter
 * ("Kernel Version:", "Application Version"). Returns the label, or '' when the letter
 * text does not print the kernel the person entered.
 */
function learnLabel(text, kernel) {
  const ids = kernelIds(kernel);
  if (!ids.length) return '';
  for (const line of String(text || '').split(/\n/)) {
    const re = /v?\d[\d.]*/gi;
    let m;
    while ((m = re.exec(line))) {
      if (!kernelIds(m[0]).some((x) => ids.includes(x))) continue;
      const before = line.slice(0, m.index).replace(/[\s:#.\-=]+$/, '');
      const words = before.split(/\s+/).filter(Boolean).slice(-4);
      while (words.length && /\d/.test(words[0])) words.shift();
      const label = words.join(' ').trim();
      if (label.length >= 3 && /[A-Za-z]{3}/.test(label)) return label;
    }
  }
  return '';
}

/** The text of one letter: its pages of the document. */
function letterText(docText, L) {
  const pages = String(docText || '').split('\n\f\n');
  if (!L || !L.pageStart) return pages.join('\n');
  return pages.slice(L.pageStart - 1, L.pageEnd || L.pageStart).join('\n');
}

module.exports = { findKernel, learnLabel, letterText, brandKernels, fromFilename };
