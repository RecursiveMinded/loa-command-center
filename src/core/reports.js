'use strict';
// Reports: the one-click Summary Report (self-contained HTML, printable to
// PDF), Excel exports, and the published-portal change list. Reports never
// show file paths or raw source names, only verified business data.

const { formatDate, todayIso } = require('./dates');
const { daysRemaining, effectiveStage, isEol } = require('./lifecycle');
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
  const due90 = rows.filter((r) => !isEol(r) && r.days != null && r.days >= 0 && r.days <= 90).sort(by);
  const due365 = rows.filter((r) => !isEol(r) && r.days != null && r.days > 90 && r.days <= 365).sort(by);
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
/**
 * Website change requests: rows where what is published differs from the
 * verified LOA, in the shape engineering expects (section, level, brand,
 * action, current and requested value).
 */
function portalChanges(records, asOf = todayIso()) {
  const out = [];
  for (const r of records) {
    if (r.archived || ['Change Requested', 'Published'].includes(r.portal_status) && r.portal_date === r.expiry_date) continue;
    const expired = r.expiry_date && r.expiry_date < asOf;
    const published = r.portal_date || '';
    let action = '', requested = r.expiry_date || '';
    if (expired && (published || r.portal_status === 'Change Needed')) {
      if (published && published === r.expiry_date && published >= asOf) continue;
      action = /PCI/i.test(r.category) ? 'Remove row' : 'Replace expired date';
      requested = action === 'Remove row' ? 'Remove from website' : 'No current LoA / waiver required';
    } else if (published && r.expiry_date && published !== r.expiry_date) {
      action = 'Update date';
    } else if (!published && r.expiry_date && r.portal_status === 'Change Needed') {
      action = 'Add date';
    } else if (r.portal_status === 'Change Needed') {
      action = 'Review';
    } else continue;
    const pci = /PCI/i.test(r.category);
    const level = /L1/.test(r.category) ? 'Level 1' : /L2/.test(r.category) ? 'Level 2' : pci ? (/^PCI/i.test(r.kernel_version || '') ? r.kernel_version : `PCI ${r.kernel_version || ''}`.trim()) : r.category;
    const cless = /Contactless/i.test(r.category);
    const section = pci ? 'PCI' : /^EMV L[12]/.test(r.category) ? `EMV ${cless ? 'Contactless' : 'Contact'} ${r.category.match(/L[12]/)[0]}` : r.category;
    const brand = /L1/.test(r.category) ? `EMV ${cless ? 'Contactless' : 'Contact'}` : pci ? 'PCI' : r.scheme;
    const d = r.expiry_date ? r.expiry_date.split('-') : null;
    const when = d ? `${+d[1]}-${+d[2]}-${d[0]} ` : '';
    const comment = pci ? `${when}${r.device} ${level}` : `${when}${r.device} (${level.replace('Level ', 'L')}) ${cless ? 'Cless' : 'Contact'}${/L2/.test(r.category) ? ` ${r.scheme}` : ''}`;
    out.push({
      id: r.id, platform: r.platform || '', bundle: r.bundle || '', device: r.device, category: r.category, scheme: r.scheme,
      section, level, brand, action, published: published || 'Blank', requested, verified: r.expiry_date || '',
      restricted: r.restricted ? 'Yes' : expired ? 'expired' : 'No', approval: r.approval_number || '',
      status: r.portal_status === 'Change Requested' ? 'Requested' : 'Not Started', portalStatus: r.portal_status || '',
      ticket: r.change_ticket || '', comment,
    });
  }
  const order = { 'Remove row': 0, 'Replace expired date': 1, 'Update date': 2, 'Add date': 3, Review: 4 };
  return out.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || order[a.action] - order[b.action] || a.device.localeCompare(b.device, undefined, { numeric: true }));
}

const CR_COLS = [
  ['Change ID', 'ticket', 10], ['Platform', 'platform', 10], ['Website Section', 'section', 20], ['Device / Model', 'device', 18],
  ['Level', 'level', 10], ['Card Brand / Type', 'brand', 18], ['Action', 'action', 22], ['Current Website Value', 'published', 20],
  ['Requested New Value', 'requested', 30], ['Restricted?', 'restricted', 11], ['Web Status', 'status', 12], ['Additional Comment', 'comment', 44],
];

/** The change request workbook: one master sheet plus one per platform. */
async function exportChangeRequest(rows, { title = 'Website Change Request' } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LOA Command Center';
  wb.created = new Date();
  const sheet = (name, list) => {
    const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = CR_COLS.map(([header, key, width]) => ({ header, key, width }));
    for (const r of list) ws.addRow(r);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF142F4C' } };
    ws.autoFilter = { from: 'A1', to: { row: 1, column: CR_COLS.length } };
  };
  sheet(`Master ${title.includes('Change') ? 'Change Request' : title} (All)`, rows);
  for (const p of [...new Set(rows.map((r) => r.platform || 'No platform'))].sort()) sheet(p, rows.filter((r) => (r.platform || 'No platform') === p));
  return Buffer.from(await wb.xlsx.writeBuffer());
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

/**
 * The briefing as an email-ready table: every certification that is expired
 * without a decision or expires within the horizon, with a blank "Renewing?"
 * column for the team to confirm which ones will not be renewed. Inline
 * styles only, so it survives pasting into Outlook or Gmail.
 */
function briefingReport({ records, analysis, briefing = '', settings = {}, asOf = todayIso(), months = 12 }) {
  const horizon = Math.round(months * 30.5);
  const rows = recRows(records.filter((r) => !r.archived && !isEol(r)), asOf)
    .filter((r) => r.days != null && r.days <= horizon && (r.days >= 0 || !['Market Approved Expiration', 'Retired'].includes(r.stageNow)))
    .sort((a, b) => a.days - b.days || String(a.device).localeCompare(String(b.device), undefined, { numeric: true }));
  const status = (d) => (d < 0 ? `Expired ${-d} d ago` : d === 0 ? 'Expires today' : `${d} days`);
  const color = (d) => (d < 0 ? '#b42318' : d <= 90 ? '#b54708' : d <= 180 ? '#a15c07' : '#344054');
  const cols = [
    ['Device', (r) => `<b>${esc(r.device)}</b>`],
    ['Platform / bundle', (r) => esc([r.platform, r.bundle].filter(Boolean).join(' · '))],
    ['Certification', (r) => esc(r.category.replace(/^EMV /, ''))],
    ['Brand', (r) => esc(r.scheme)],
    ['Approval no.', (r) => esc(r.approval_number)],
    ['Expires', (r) => esc(formatDate(r.expiry_date))],
    ['Status', (r) => `<span style="color:${color(r.days)};font-weight:600">${esc(status(r.days))}</span>`],
    ['Stage', (r) => esc(r.stageNow)],
    ['Renewal path', (r) => esc(r.renewal_path)],
    ['Renewing? (Yes / No, end of life)', () => ''],
  ];
  const th = 'style="text-align:left;padding:6px 8px;background:#142f4c;color:#fff;font-size:12px;border:1px solid #142f4c"';
  const td = 'style="padding:5px 8px;border:1px solid #d0d5dd;font-size:12px;vertical-align:top"';
  const s = analysis.summary;
  const intro = esc(briefing).replace(/\n/g, '<br>');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828">
<p style="font-size:14px;margin:0 0 6px"><b>Certification briefing, ${esc(formatDate(asOf))}</b></p>
<p style="font-size:12px;margin:0 0 10px;color:#475467">${s.expiredOpen} expired without a decision · ${s.due90} due in 90 days · ${s.due365} due in 12 months · ${rows.length} listed below (next ${months} months)</p>
${intro ? `<p style="font-size:12px;margin:0 0 12px">${intro}</p>` : ''}
<p style="font-size:12px;margin:0 0 8px">Please confirm in the last column which of these will <b>not</b> be renewed, so they can be marked end of life.</p>
<table style="border-collapse:collapse;width:100%"><thead><tr>${cols.map((c) => `<th ${th}>${esc(c[0])}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td ${td}>${c[1](r)}</td>`).join('')}</tr>`).join('\n')}</tbody></table>
${settings.userName ? `<p style="font-size:12px;margin-top:12px">${esc(settings.userName)}</p>` : ''}</div>`;
  const text = [
    `Certification briefing, ${formatDate(asOf)}`, '',
    cols.map((c) => c[0]).join('\t'),
    ...rows.map((r) => [r.device, [r.platform, r.bundle].filter(Boolean).join(' · '), r.category.replace(/^EMV /, ''), r.scheme, r.approval_number || '',
      formatDate(r.expiry_date), status(r.days), r.stageNow, r.renewal_path || '', ''].join('\t')),
  ].join('\n');
  return { html, text, ids: rows.map((r) => r.id), count: rows.length };
}

/**
 * The Level 3 enablement sheet: one row per device with every L1, L2 and
 * brand approval number and expiry, which acquirers need for their own
 * certification. Built from the Devices coverage view.
 */
async function exportL3Sheet(cov, { asOf = todayIso() } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LOA Command Center';
  wb.created = new Date();
  const ws = wb.addWorksheet('L3 approval numbers', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
  const name = (c) => (c.group === 'L2 Contactless' ? `L2 ${c.label}` : c.group === 'Contactless reader' ? `${c.label} (reader)` : c.label);
  const cols = [{ header: 'Platform', key: 'platform', width: 12 }, { header: 'Bundle', key: 'bundle', width: 14 }, { header: 'Device', key: 'device', width: 20 }];
  for (const c of cov.columns) cols.push({ header: `${name(c)} approval`, key: `${c.key}#n`, width: 22 }, { header: `${name(c)} expires`, key: `${c.key}#d`, width: 12 });
  ws.columns = cols;
  for (const r of cov.rows) {
    const row = { platform: r.platform, bundle: r.bundle, device: r.device };
    let any = false;
    for (const c of cov.columns) {
      const cell = r.cells[c.key];
      const rec = cell.record;
      if (rec) {
        any = true;
        row[`${c.key}#n`] = `${rec.approval_number || ''}${rec.sharedFrom ? ` (via ${rec.sharedFrom})` : ''}${rec.eol ? ' (end of life)' : ''}`;
        row[`${c.key}#d`] = rec.expiry_date || '';
      } else if (cell.status === 'na') row[`${c.key}#n`] = 'N/A';
    }
    if (!any) continue;
    const added = ws.addRow(row);
    for (const c of cov.columns) {
      const rec = r.cells[c.key].record;
      if (rec && rec.expiry_date && rec.expiry_date < asOf) added.getCell(`${c.key}#d`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7D3' } };
    }
  }
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF142F4C' } };
  ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Bundle report: the register laid out like the published kernel bundle page,
// so the two can be compared side by side.
// ---------------------------------------------------------------------------

const mdy = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}` : '');

function bundleTables(v) {
  const cellOf = (c) => (c ? (c.eol ? `${mdy(c.expiry_date)} (EOL)` : mdy(c.expiry_date)) : '');
  return [
    { title: 'PCI', head: ['Terminal', 'Version', 'Exp Date'], rows: v.sections.pci.map((r) => [r.device, r.version, cellOf(r.cells.date)]), cells: v.sections.pci.map((r) => [null, null, r.cells.date]) },
    { title: 'EMV Contact', head: ['Terminal', 'L1 Contact', 'TQM'], rows: v.sections.contact.map((r) => [r.device, cellOf(r.cells.l1), cellOf(r.cells.tqm)]), cells: v.sections.contact.map((r) => [null, r.cells.l1, r.cells.tqm]) },
    { title: 'EMV Contactless', head: ['Terminal', 'L1 Contactless', 'TQM'], rows: v.sections.contactless.map((r) => [r.device, cellOf(r.cells.l1), cellOf(r.cells.tqm)]), cells: v.sections.contactless.map((r) => [null, r.cells.l1, r.cells.tqm]) },
    { title: 'Level 2 · EMV Contactless', head: ['Terminal', ...v.brands.map((b) => b.label)], rows: v.sections.l2contactless.map((r) => [r.device, ...v.brands.map((b) => cellOf(r.cells[b.key]))]), cells: v.sections.l2contactless.map((r) => [null, ...v.brands.map((b) => r.cells[b.key])]) },
  ];
}

function bundleReport(v, { company = '', asOf = todayIso() } = {}) {
  const tables = bundleTables(v);
  const l2 = v.l2contact;
  const kernel = `${v.l2contactKernel ? `the EMV Contact kernel v${esc(v.l2contactKernel)}` : 'an EMV Contact kernel'}${l2 && l2.expiry_date ? `, which expires on ${mdy(l2.expiry_date)}` : ', with no expiry date on file'}`;
  const tone = (c) => (!c || !c.expiry_date ? '' : c.eol ? 'color:#6b7280' : c.expiry_date < asOf ? 'background:#fde2e1;color:#8a1c1c' : '');
  const body = tables.map((t) => `<h2>${esc(t.title)}</h2>
    <table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
    ${t.rows.map((row, i) => `<tr>${row.map((c, j) => `<td style="${j ? 'text-align:center;' : ''}${tone(t.cells[i][j])}">${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${t.head.length}">None</td></tr>`}
    </tbody></table>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.platform)} ${esc(v.bundle)}</title>
  <style>body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937;margin:32px;max-width:1100px}
  h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}.muted{color:#6b7280}
  table{border-collapse:collapse;width:100%;margin-bottom:6px}th,td{border:1px solid #d1d5db;padding:5px 8px}th{background:#f3f4f6;text-align:center}
  td:first-child,th:first-child{text-align:left;white-space:nowrap}@media print{body{margin:12mm}}</style></head><body>
  <h1>${esc(v.bundle)}${v.platform && !String(v.bundle).toUpperCase().includes(String(v.platform).toUpperCase()) ? ` · ${esc(v.platform)}` : ''}</h1>
  <div class="muted">${company ? `${esc(company)} · ` : ''}From the certification register, ${formatDate(asOf)} · ${v.dates} expiry date${v.dates === 1 ? '' : 's'}${v.page ? ` · the published page (${esc(v.page.filename)}) shows ${v.page.dates}` : ''}</div>
  <p>This kernel bundle uses ${kernel}. The EMV Contact Level 2 kernel is one approval shared by every device in the bundle.</p>
  <h2 style="margin-top:18px">Terminal &amp; Level 1 Certifications</h2>${body}
  <p class="muted">Blank cell: no approval on file. Red: expired.</p></body></html>`;
  return { html, dates: v.dates };
}

async function bundleWorkbook(v) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LOA Command Center';
  wb.created = new Date();
  for (const t of bundleTables(v)) {
    const ws = wb.addWorksheet(t.title.replace(/[^\w &-]/g, ' ').slice(0, 31));
    ws.addRow(t.head);
    for (const r of t.rows) ws.addRow(r);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = i ? 14 : 20; });
  }
  const ws = wb.addWorksheet('EMV Contact L2');
  ws.addRow(['Kernel', 'Exp Date']);
  ws.addRow([v.l2contactKernel || '', v.l2contact ? mdy(v.l2contact.expiry_date) : '']);
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
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

module.exports = { summaryReport, briefingReport, bundleReport, bundleWorkbook, exportL3Sheet, exportExcel, exportCsv, portalChanges, exportChangeRequest, digestEmail, timelineSvg, esc };
