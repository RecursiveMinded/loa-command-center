import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Ring, fmtDate, fmtMonth, fmtWhen, plural, useLoad, Spinner, toastError } from '../lib.js';
import { call } from '../api.js';
import { ActionItem } from './plan.js';

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
        <div class="card"><div class="hd"><h3>By card brand</h3><a onClick=${() => app.go('matrix')}>Matrix →</a></div>
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
  return html`<div class="card"><div class="hd"><div class="ai-head"><span class="spark"><${Icon} name="spark" /></span><h3>Briefing</h3>
      ${b ? html`<span class="tag">${b.ai ? 'Local AI' : 'Rules engine'}</span>` : null}</div>
      <div class="row"><button class="btn sm ghost icon" title="Refresh" onClick=${load}><${Icon} name="refresh" /></button>
      <button class="btn sm" onClick=${app.openAi}>Ask</button></div></div>
    <div class="bd">${loading ? html`<div class="row muted"><${Spinner} /> Thinking…</div>` : html`<div class="ai-box small">${b ? b.text : ''}</div>`}
      ${b && b.error ? html`<div class="muted small mt">Local AI unavailable (${b.error}); showing the rules-engine briefing.</div>` : null}</div></div>`;
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
      <div class="card" onClick=${() => app.go('settings', { tab: 'data' })}><${Icon} name="globe" /><h3>Import a portal page</h3><p class="muted small">Load the certification matrix from a saved web page or PDF of your published kernel bundle page.</p></div>
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
