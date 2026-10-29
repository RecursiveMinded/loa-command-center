import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Ring, fmtDate, fmtMonth, fmtWhen, plural, useLoad, Spinner, toast, toastError, Modal, Select } from '../lib.js';
import { call, saveAs, printHtml } from '../api.js';
import { ActionItem } from './plan.js';

/** Bundles that no longer match their website page, shown at the top of Today. */
function BundleAlerts({ app }) {
  const [list] = useLoad(() => call('listBundles'), [app.version]);
  const off = (list || []).filter((b) => b.issues && !b.issues.ok);
  if (!off.length) return null;
  return html`${off.map((b) => html`<div class="callout warn row" style="margin-bottom:12px"><${Icon} name="warn" />
    <span class="grow"><b>${b.platform} ${b.bundle} does not match its website page:</b> ${b.dates} dates here, ${b.page.dates} on the page.</span>
    <button class="btn sm primary" onClick=${() => app.go('bundles')}>Review</button></div>`)}`;
}

const FREQ = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export function Dashboard({ app }) {
  const [d, reload] = useLoad(() => call('getDashboard'), [app.version]);
  if (!d) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  if (d.empty) return html`<${Welcome} app=${app} />`;
  const s = d.summary;
  const hello = app.settings.userName ? `Good ${greeting()}, ${app.settings.userName.split(' ')[0]}` : `Good ${greeting()}`;
  const go = (filter) => app.go('register', { filter });
  return html`
    <div class="page-head"><div><h1>${hello}</h1><p>${fmtDate(d.asOf)} · ${plural(s.total, 'active certification')} · ${plural(d.openActions, 'open action')}</p></div></div>

    <${BundleAlerts} app=${app} />
    <div class="kpis">
      <div class="card kpi row gap-l" onClick=${() => app.go('reports')} title="Share of records that are current, dated, owned and evidenced">
        <${Ring} value=${s.healthScore} /><div><div class="l">Portfolio health</div><div class="s">${s.compliancePct}% current · ${s.evidencePct}% with LOA</div></div></div>
      <${Kpi} cls="bad" v=${s.expiredOpen} l="Expired" s="Need a decision" onClick=${() => go({ window: 'expired' })} />
      <${Kpi} cls="crit" v=${s.due90} l="Due in 90 days" s=${`${s.byWindow.d30 || 0} within 30 days`} onClick=${() => go({ window: 'd90' })} />
      <${Kpi} cls="warn" v=${s.due365} l="Due in 12 months" s=${`${s.due180} within 6 months`} onClick=${() => go({ window: 'd365' })} />
      <${Kpi} cls="info" v=${s.inboxPending} l="LOAs to review" s="In the inbox" onClick=${() => app.go('inbox')} />
      <${Kpi} cls=${s.missing ? 'warn' : 'good'} v=${s.missing} l="Missing dates" s=${`${s.total - s.owned} without owner`} onClick=${() => go({ window: 'missing' })} />
    </div>

    <div class="dash">
      <div class="cards">
        <div class="card"><div class="hd"><div class="ai-head"><span class="spark"><${Icon} name="spark" /></span><h3>Your action plan</h3></div>
          <a onClick=${() => app.go('plan')}>See all ${d.openActions} →</a></div>
          <div class="bd">${d.actions.length ? d.actions.slice(0, 8).map((a) => html`<${ActionItem} key=${a.key} a=${a} app=${app} onChange=${reload} compact />`)
            : html`<div class="empty"><${Icon} name="check" /><h3>Nothing needs you right now</h3><div>New actions appear as dates approach.</div></div>`}</div></div>
        <div class="card"><div class="hd"><h3>Expirations over the next 18 months</h3><span class="muted small">Click a month to see the records</span></div>
          <div class="bd"><${Timeline} data=${d.timeline} app=${app} /></div></div>
      </div>
      <div class="cards">
        <${Briefing} app=${app} />
        <div class="card"><div class="hd"><h3>By card brand</h3><a onClick=${() => app.go('bundles')}>Bundles →</a></div>
          <div class="bd"><table class="t compact"><thead><tr><th>Brand</th><th class="num">Total</th><th class="num">Expired</th><th class="num">≤ 90 d</th><th class="num">≤ 12 mo</th></tr></thead><tbody>
            ${Object.entries(s.byScheme).sort((a, b) => b[1].total - a[1].total).map(([k, v]) => html`<tr class="click" onClick=${() => go({ scheme: k })}>
              <td>${k}</td><td class="num">${v.total}</td><td class="num" style=${v.expired ? 'color:var(--bad);font-weight:650' : ''}>${v.expired || '–'}</td>
              <td class="num" style=${v.due90 ? 'color:var(--crit);font-weight:650' : ''}>${v.due90 || '–'}</td><td class="num">${v.due365 || '–'}</td></tr>`)}
          </tbody></table></div></div>
        <div class="card pad"><div class="row between"><div class="row"><${Icon} name="bell" /><h3>${d.notify.enabled ? `${FREQ[d.notify.frequency]} digest` : 'Digest is off'}</h3></div>
          <a onClick=${() => app.go('settings', { tab: 'notify' })}>Change</a></div>
          <p class="muted small mt">${d.notify.enabled && d.nextNotification ? `Next one ${fmtWhen(d.nextNotification)}. It lists the actions to take, and opens the plan when clicked.` : 'Turn on a daily, weekly or monthly reminder in Settings.'}</p></div>
      </div>
    </div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

function Kpi({ v, l, s, cls, onClick }) {
  return html`<div class=${`card kpi ${v ? cls : ''}`} onClick=${onClick} role="button" tabindex="0"><div class="v">${v}</div><div class="l">${l}</div><div class="s">${s}</div></div>`;
}

function Timeline({ data, app }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return html`<div class="chart-bars">${data.map((m, i) => html`<div class=${`b ${m.count ? (i < 3 ? 'hot' : '') : 'zero'}`} key=${m.key}
      title=${`${fmtMonth(m.key)}: ${m.count} expiring${Object.keys(m.bySchemes).length ? `\n${Object.entries(m.bySchemes).map(([k, v]) => `${k}: ${v}`).join('\n')}` : ''}`}
      onClick=${() => m.count && app.go('register', { filter: { month: m.key } })}>
      <em>${m.count || ''}</em><i style=${`height:${(m.count / max) * 112}px`}></i><span>${fmtMonth(m.key)}</span></div>`)}</div>`;
}

function Briefing({ app }) {
  const [b, setB] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try { setB(await call('aiBriefing')); } catch (e) { toastError(e); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [app.version]);
  const [exp, setExp] = useState(false);
  return html`<div class="card"><div class="hd"><div class="ai-head"><span class="spark"><${Icon} name="spark" /></span><h3>Briefing</h3>
      ${b ? html`<span class="tag">${b.ai ? 'Local AI' : 'Rules engine'}</span>` : null}</div>
      <div class="row"><button class="btn sm ghost icon" title="Refresh" onClick=${load}><${Icon} name="refresh" /></button>
      <button class="btn sm" onClick=${app.openAi}>Ask</button>
      <button class="btn sm" onClick=${() => setExp(true)} title="An email-ready table of what is expired or due, to confirm what will not be renewed"><${Icon} name="download" /> Export</button></div></div>
    ${exp ? html`<${BriefingExport} briefing=${b ? b.text : ''} onClose=${() => setExp(false)} />` : null}
    <div class="bd">${loading ? html`<div class="row muted"><${Spinner} /> Thinking…</div>` : html`<div class="ai-box small">${b ? b.text : ''}</div>`}
      ${b && b.error ? html`<div class="muted small mt">Local AI unavailable (${b.error}); showing the rules-engine briefing.</div>` : null}</div></div>`;
}

/** The briefing as an email-ready table: copy into an email, save to Excel, or print. */
function BriefingExport({ briefing, onClose }) {
  const [months, setMonths] = useState('12');
  const [rep] = useLoad(() => call('briefingReport', { briefing, months: Number(months) }), [months]);
  const copy = async () => {
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([rep.html], { type: 'text/html' }), 'text/plain': new Blob([rep.text], { type: 'text/plain' }) })]);
      } else await navigator.clipboard.writeText(rep.text);
      toast('Copied. Paste it into an email.', 'ok');
    } catch (e) { toastError(e); }
  };
  const excel = async () => { try { await saveAs('Certification briefing.xlsx', await call('exportExcel', { ids: rep.ids }), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };
  const print = () => printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Certification briefing</title></head><body style="margin:24px">${rep.html}</body></html>`);
  return html`<${Modal} title="Export briefing" wide onClose=${onClose}>
    <div class="row wrap"><span class="muted small">Show certifications expired or expiring in the next</span>
      <${Select} value=${months} onChange=${setMonths} options=${[{ value: '6', label: '6 months' }, { value: '12', label: '12 months' }, { value: '18', label: '18 months' }]} />
      <span class="grow"></span>
      <button class="btn primary" disabled=${!rep} onClick=${copy}><${Icon} name="mail" /> Copy for email</button>
      <button class="btn" disabled=${!rep} onClick=${excel}><${Icon} name="download" /> Excel</button>
      <button class="btn" disabled=${!rep} onClick=${print}><${Icon} name="report" /> Print / PDF</button></div>
    ${rep ? html`<div class="briefing-preview mt" dangerouslySetInnerHTML=${{ __html: rep.html }}></div>` : html`<div class="row mt"><${Spinner} /> Building…</div>`}<//>`;
}

function Welcome({ app }) {
  const sample = async () => {
    try { await call('loadSampleData'); app.refresh(); } catch (e) { toastError(e); }
  };
  return html`<div style="max-width:1100px">
    <h1>Welcome to LOA Command Center</h1>
    <p class="muted" style="font-size:15px;margin-top:6px">Track every Letter of Approval and certification in one place. Drop your LOAs in, and the app reads them, matches them to devices, and tells you what to renew and when.</p>
    <div class="onboard">
      <div class="card" onClick=${() => app.go('inbox')}><${Icon} name="upload" /><h3>Drop your LOAs</h3><p class="muted small">PDFs or scans, one or many at a time. Merged PDFs are split into letters automatically.</p></div>
      <div class="card" onClick=${() => app.go('settings', { tab: 'data' })}><${Icon} name="table" /><h3>Import a tracker</h3><p class="muted small">Bring in your existing Excel or CSV certification list. Columns are recognised automatically.</p></div>
      <div class="card" onClick=${() => app.go('bundles')}><${Icon} name="globe" /><h3>Read a kernel bundle page</h3><p class="muted small">Load a bundle's matrix from the PDF or saved web page of your published kernel bundle page.</p></div>
      <div class="card" onClick=${sample}><${Icon} name="spark" /><h3>Try sample data</h3><p class="muted small">Explore with a fictional portfolio. Clear it from Settings when you are ready for real data.</p></div>
    </div>
    <div class="card pad mt-l"><h3>How it works</h3>
      <div class="grid3 mt">
        <div><b>1. Read</b><p class="muted small">Text is read from each PDF; scanned pages are OCR'd on this computer. Nothing is uploaded.</p></div>
        <div><b>2. Review</b><p class="muted small">Each letter becomes a proposed change. Safe ones can be approved in one click; anything unusual waits for you.</p></div>
        <div><b>3. Act</b><p class="muted small">The planner groups renewals into waves, flags final expiries and gaps, and sends you a daily, weekly or monthly digest.</p></div>
      </div></div>
  </div>`;
}
