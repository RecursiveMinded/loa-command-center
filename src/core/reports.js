'use strict';
// Reports: the one-click Summary Report (self-contained HTML, printable to
// PDF), Excel exports, and the published-portal change list. Reports never
// show file paths or raw source names, only verified business data.

const { formatDate, todayIso } = require('./dates');
const { daysRemaining, effectiveStage } = require('./lifecycle');
const { timeline } = require('./engine');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function recRows(records, asOf) {
  return records.map((r) => ({ ...r, days: daysRemaining(r, asOf), stageNow: effectiveStage(r, asOf) }));
}

function table(rows, cols, empty = 'None') {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td class="${c[2] || ''}">${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function timelineSvg(tl) {
  const w = 720, h = 170, pad = 28, bw = (w - pad * 2) / tl.length;
  const max = Math.max(1, ...tl.map((t) => t.count));
  const bars = tl.map((t, i) => {
    const bh = Math.round(((h - 50) * t.count) / max);
    const x = pad + i * bw + 3, y = h - 26 - bh;
    const [yy, mm] = t.key.split('-');
    const m = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][Number(mm) - 1];
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${(bw - 6).toFixed(1)}" height="${bh}" rx="3" fill="${i < 3 ? '#d4483b' : i < 6 ? '#e09a2c' : '#2f6fb3'}"/>`
      + (t.count ? `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${y - 4}" text-anchor="middle" font-size="10" fill="#333">${t.count}</text>` : '')
      + `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${h - 12}" text-anchor="middle" font-size="10" fill="#666">${m}</text>`
      + (mm === '01' || i === 0 ? `<text x="${x.toFixed(1)}" y="${h - 1}" font-size="9" fill="#999">${yy}</text>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Expirations by month">${bars}</svg>`;
}

/**
 * Build the Summary Report.
 * analysis: output of engine.analyze; records: all records.
 */
function summaryReport({ analysis, records, settings = {}, asOf = todayIso(), title = 'Certification Summary Report', filterLabel = '' }) {
  const s = analysis.summary;
  const rows = recRows(records.filter((r) => !r.archived), asOf);
  const name = (r) => `<b>${esc(r.device)}</b>${r.platform ? ` <span class="muted">${esc(r.platform)}${r.bundle ? ` · ${esc(r.bundle)}` : ''}</span>` : ''}`;
  const cols = [
    ['Device', name],
    ['Brand', (r) => esc(r.scheme)],
    ['Approval', (r) => esc(r.category)],
    ['Expires', (r) => esc(formatDate(r.expiry_date)), 'nowrap'],
    ['Days', (r) => (r.days == null ? '' : r.days), 'num'],
    ['Owner', (r) => esc(r.owner) || '<span class="muted">Unassigned</span>'],
    ['Stage', (r) => esc(r.stageNow)],
  ];
  const by = (a, b) => (a.days ?? 99999) - (b.days ?? 99999);
  const due90 = rows.filter((r) => r.days != null && r.days >= 0 && r.days <= 90).sort(by);
  const due365 = rows.filter((r) => r.days != null && r.days > 90 && r.days <= 365).sort(by);
  const expired = rows.filter((r) => r.days != null && r.days < 0 && !['Market Approved Expiration', 'Retired'].includes(r.stageNow) && r.disposition !== 'Market Approved Expiration').sort(by);
  const restricted = rows.filter((r) => (r.restricted || r.extension_used) && r.days != null && r.days >= 0 && r.days <= 730).sort(by);
  const open = analysis.actions.filter((a) => a.status === 'open');
  const top = open.filter((a) => a.priority <= 2).slice(0, 15);
  const waves = open.filter((a) => a.kind === 'wave');
  const portal = open.filter((a) => a.kind === 'portal');
  const schemes = Object.entries(s.byScheme).sort((a, b) => b[1].total - a[1].total);
  const platforms = Object.entries(s.byPlatform).sort((a, b) => b[1].total - a[1].total);
  const tile = (label, value, tone = '') => `<div class="tile ${tone}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: Letter; margin: 14mm; }
  body { font: 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #1d2430; margin: 0; padding: 24px; background: #fff; }
  h1 { font-size: 22px; margin: 0; color: #142f4c; }
  h2 { font-size: 15px; margin: 26px 0 8px; color: #142f4c; border-bottom: 2px solid #e6ebf2; padding-bottom: 4px; }
  .sub { color: #5b6677; margin-top: 2px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 16px; }
  .tile { border: 1px solid #e3e8ef; border-radius: 10px; padding: 10px 12px; }
  .tile .v { font-size: 24px; font-weight: 700; } .tile .l { color: #5b6677; font-size: 12px; }
  .tile.red .v { color: #c0392b; } .tile.amber .v { color: #c67c0e; } .tile.green .v { color: #1e8a4c; } .tile.blue .v { color: #2f6fb3; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { text-align: left; background: #142f4c; color: #fff; font-weight: 600; padding: 6px 8px; font-size: 12px; }
  td { border-bottom: 1px solid #edf0f4; padding: 5px 8px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .num { text-align: right; } .nowrap { white-space: nowrap; } .muted { color: #8a94a3; }
  .p1 { color: #c0392b; font-weight: 700; } .p2 { color: #c67c0e; font-weight: 700; } .p3 { color: #2f6fb3; } .p4 { color: #6b7685; }
  .why { color: #5b6677; font-size: 12px; }
  .foot { margin-top: 30px; color: #8a94a3; font-size: 11px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(settings.companyName || '')}${settings.companyName ? ' · ' : ''}As of ${esc(formatDate(asOf))}${filterLabel ? ` · ${esc(filterLabel)}` : ''}${settings.userName ? ` · Prepared by ${esc(settings.userName)}` : ''}</div>
<div class="tiles">
  ${tile('Certifications tracked', s.total, 'blue')}
  ${tile('Portfolio health (0–100)', s.healthScore, s.healthScore >= 80 ? 'green' : s.healthScore >= 60 ? 'amber' : 'red')}
  ${tile('Expired, unresolved', s.expiredOpen, s.expiredOpen ? 'red' : 'green')}
  ${tile('Due in 90 days', s.due90, s.due90 ? 'amber' : 'green')}
  ${tile('Due in 12 months', s.due365)}
  ${tile('Missing expiry date', s.missing, s.missing ? 'amber' : '')}
  ${tile('Have LOA on file', `${s.evidencePct}%`)}
  ${tile('Have an owner', `${s.ownerPct}%`)}
</div>
<h2>Expirations by month (next 18 months)</h2>
${timelineSvg(timeline(records, { asOf, months: 18 }))}
<h2>Priority actions</h2>
${table(top, [
    ['Priority', (a) => `<span class="p${a.priority}">${esc(a.priorityLabel)}</span>`, 'nowrap'],
    ['Action', (a) => `${esc(a.title)}<div class="why">${esc(a.why)}</div>`],
    ['Due', (a) => esc(formatDate(a.due)), 'nowrap'],
  ], 'No critical or high-priority actions.')}
${waves.length ? `<h2>Renewal waves</h2>${table(waves, [
    ['Wave', (a) => esc(a.title)],
    ['Devices', (a) => esc((a.devices || []).join(', '))],
    ['Start by', (a) => esc(formatDate(a.due)), 'nowrap'],
  ])}` : ''}
<div class="two">
<div><h2>By brand</h2>${table(schemes, [
    ['Brand', ([k]) => esc(k)], ['Total', ([, v]) => v.total, 'num'], ['Expired', ([, v]) => v.expired, 'num'], ['≤90 d', ([, v]) => v.due90, 'num'], ['≤12 mo', ([, v]) => v.due365, 'num'],
  ])}</div>
<div><h2>By platform</h2>${table(platforms, [
    ['Platform', ([k]) => esc(k)], ['Total', ([, v]) => v.total, 'num'], ['Expired', ([, v]) => v.expired, 'num'], ['≤12 mo', ([, v]) => v.due365, 'num'],
  ])}</div>
</div>
<h2>Expired and unresolved (${expired.length})</h2>
${table(expired, cols, 'Nothing expired without a decision.')}
<h2>Due in the next 90 days (${due90.length})</h2>
${table(due90, cols, 'Nothing due in the next 90 days.')}
<h2>Due in 91 days to 12 months (${due365.length})</h2>
${table(due365, cols, 'Nothing else due within a year.')}
${restricted.length ? `<h2>Final expiries: restricted / extension used (${restricted.length})</h2>${table(restricted, cols)}` : ''}
${portal.length ? `<h2>Published values to update (${portal.length})</h2>${table(portal, [['Change', (a) => esc(a.title)], ['Why', (a) => `<span class="why">${esc(a.why)}</span>`]])}` : ''}
<div class="foot">Generated by LOA Command Center on ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}. Days are counted from ${esc(formatDate(asOf))}. Dates reflect verified records in the app; confirm with the issuing body before external commitments.</div>
</body></html>`;
}

/** Records whose published value differs from the verified one (the portal "delta" list). */
function portalChanges(records) {
  return records
    .filter((r) => !r.archived && (r.portal_status === 'Change Needed' || (r.portal_date && r.expiry_date && r.portal_date !== r.expiry_date)))
    .map((r) => ({
      platform: r.platform, bundle: r.bundle, device: r.device, category: r.category, scheme: r.scheme,
      published: r.portal_date || '', verified: r.expiry_date || '', approval: r.approval_number || '',
      status: r.portal_status, ticket: r.change_ticket || '',
    }));
}

const EXPORT_COLS = [
  ['Platform', 'platform', 12], ['Bundle', 'bundle', 14], ['Device', 'device', 18], ['Approval type', 'category', 20],
  ['Brand', 'scheme', 14], ['Kernel / version', 'kernel_version', 16], ['Approval number', 'approval_number', 26],
  ['Issued', 'issue_date', 12], ['Expires', 'expiry_date', 12], ['Days left', 'days', 10], ['Stage', 'stageNow', 20],
  ['Disposition', 'disposition', 22], ['Owner', 'owner', 16], ['Customer', 'customer', 16], ['Market', 'market', 14],
  ['Next action', 'next_action', 28], ['Next action date', 'next_action_date', 14], ['Restricted', 'restricted', 10],
  ['LOAs on file', 'doc_count', 10], ['Published date', 'portal_date', 14], ['Portal status', 'portal_status', 16],
  ['Change ticket', 'change_ticket', 14], ['Tags', 'tags', 24], ['Notes', 'notes', 40],
];

async function exportExcel({ records, analysis, asOf = todayIso() }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LOA Command Center';
  wb.created = new Date();
  const navy = 'FF142F4C';

  const ws = wb.addWorksheet('Certifications', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLS.map(([header, key, width]) => ({ header, key, width }));
  for (const r of recRows(records, asOf)) {
    const row = {};
    for (const [, k] of EXPORT_COLS) row[k] = k === 'restricted' ? (r.restricted ? 'Yes' : '') : r[k] ?? '';
    const added = ws.addRow(row);
    const fill = r.days == null ? null : r.days < 0 ? 'FFF8D7D3' : r.days <= 90 ? 'FFFCE8C8' : r.days <= 365 ? 'FFFFF6DB' : null;
    if (fill) added.getCell('days').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  ws.autoFilter = { from: 'A1', to: { row: 1, column: EXPORT_COLS.length } };

  if (analysis) {
    const wa = wb.addWorksheet('Action plan', { views: [{ state: 'frozen', ySplit: 1 }] });
    wa.columns = [
      { header: 'Priority', key: 'p', width: 10 }, { header: 'Action', key: 't', width: 70 },
      { header: 'Why', key: 'w', width: 80 }, { header: 'Due', key: 'd', width: 12 }, { header: 'Status', key: 's', width: 10 },
    ];
    for (const a of analysis.actions) wa.addRow({ p: a.priorityLabel, t: a.title, w: a.why, d: a.due || '', s: a.status });
    wa.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wa.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };

    const sm = wb.addWorksheet('Summary');
    const s = analysis.summary;
    sm.columns = [{ header: 'Measure', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 14 }];
    [['As of', asOf], ['Certifications tracked', s.total], ['Portfolio health (0-100)', s.healthScore], ['Expired, unresolved', s.expiredOpen],
      ['Due in 90 days', s.due90], ['Due in 180 days', s.due180], ['Due in 12 months', s.due365], ['Missing expiry date', s.missing],
      ['LOA on file (%)', s.evidencePct], ['Owner assigned (%)', s.ownerPct]].forEach(([k, v]) => sm.addRow({ k, v }));
    sm.getRow(1).font = { bold: true };
  }
  const changes = portalChanges(records);
  if (changes.length) {
    const wp = wb.addWorksheet('Portal changes');
    wp.columns = [
      { header: 'Platform', key: 'platform', width: 10 }, { header: 'Bundle', key: 'bundle', width: 14 }, { header: 'Device', key: 'device', width: 18 },
      { header: 'Approval type', key: 'category', width: 20 }, { header: 'Brand', key: 'scheme', width: 14 }, { header: 'Published', key: 'published', width: 12 },
      { header: 'Verified', key: 'verified', width: 12 }, { header: 'Approval number', key: 'approval', width: 26 }, { header: 'Status', key: 'status', width: 16 }, { header: 'Ticket', key: 'ticket', width: 12 },
    ];
    changes.forEach((c) => wp.addRow(c));
    wp.getRow(1).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function exportCsv(records, asOf = todayIso()) {
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [EXPORT_COLS.map((c) => q(c[0])).join(',')];
  for (const r of recRows(records, asOf)) lines.push(EXPORT_COLS.map(([, k]) => q(k === 'restricted' ? (r.restricted ? 'Yes' : '') : r[k])).join(','));
  return '﻿' + lines.join('\r\n');
}

/** Plain-text email body for the digest (no source paths, per policy). */
function digestEmail(dg, analysis, { settings = {} } = {}) {
  const s = analysis.summary;
  const lines = [
    `Certification update, ${formatDate(analysis.asOf)}`,
    '',
    `Portfolio: ${s.total} certifications, health ${s.healthScore}/100`,
    `Expired and unresolved: ${s.expiredOpen}`,
    `Due in 90 days: ${s.due90}   Due in 6 months: ${s.due180}   Due in 12 months: ${s.due365}`,
    '',
    'Actions:',
    ...dg.actions.map((a) => `  • [${a.priorityLabel}] ${a.title}`),
    '',
    settings.userName ? `— ${settings.userName}` : '',
  ];
  return lines.join('\n');
}

module.exports = { summaryReport, exportExcel, exportCsv, portalChanges, digestEmail, timelineSvg, esc };
