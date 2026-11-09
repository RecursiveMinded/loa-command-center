import { useState } from 'preact/hooks';
import { html, Icon, useLoad, Spinner, toast, toastError, Modal, Select, fmtDate, plural } from './lib.js';
import { call } from './api.js';

const PILL = { incert: 'brand', mandate: 'expired', eol: 'retired', letexpire: 'retired', waiver: 'critical', renewing: 'info', expired: 'expired', expiring: 'warning', certified: 'good', nodate: 'unknown' };

/**
 * The certifications team loop, run through the person: the questions email to copy and
 * send, a box to paste the team's reply into (read into decisions to confirm), and every
 * approval's status with its kernel version.
 */
export function CertQuestions({ onClose, app, start = 'email' }) {
  const [tab, setTab] = useState(start);
  return html`<${Modal} title="Certifications team" wide onClose=${onClose}>
    <div class="tabs">${[['email', 'Questions to send'], ['reply', 'Paste their reply'], ['status', 'Status by kernel']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div class="mt">${tab === 'email' ? html`<${Email} />` : tab === 'reply' ? html`<${Reply} app=${app} onDone=${() => setTab('status')} />` : html`<${Status} app=${app} />`}</div>
  <//>`;
}

function Email() {
  const [months, setMonths] = useState('12');
  const [q] = useLoad(() => call('certQuestions', { months: Number(months) }), [months]);
  const copy = async () => {
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([q.html], { type: 'text/html' }), 'text/plain': new Blob([q.text], { type: 'text/plain' }) })]);
      } else await navigator.clipboard.writeText(q.text);
      toast('Copied. Paste it into an email to the certifications team, then paste their answer under "Paste their reply".', 'ok');
    } catch (e) { toastError(e); }
  };
  const mail = () => { location.href = `mailto:?subject=${encodeURIComponent(q.subject)}&body=${encodeURIComponent(q.text.slice(0, 1800))}`; };
  return html`<div>
    <p class="muted small" style="margin-top:0">Where the app cannot decide which kernel bundle an LOA belongs to, a bundle's kernel is unknown, or an approval is expiring or expired without a decision, it asks here. The website pages are only as current as their last update, so ask before guessing.</p>
    <div class="row wrap"><span class="muted small">Renewal status for approvals expiring in the next</span>
      <${Select} value=${months} onChange=${setMonths} options=${[{ value: '6', label: '6 months' }, { value: '12', label: '12 months' }, { value: '18', label: '18 months' }]} /></div>
    ${!q ? html`<div class="row mt"><${Spinner} /> Collecting questions…</div>` : !q.count ? html`<div class="callout good mt">No open questions: every LOA in the inbox has a kernel that a bundle runs, and nothing expires in this window without a decision.</div>` : html`
      <div class="mt"><b>Subject:</b> ${q.subject}</div>
      <div class="excerpt mt" style="max-height:48vh;white-space:pre-wrap">${q.text}</div>
      <div class="row mt"><button class="btn primary" onClick=${copy}><${Icon} name="mail" /> Copy email</button>
        <button class="btn" onClick=${mail}>Open in mail app</button><span class="faint small">Copy keeps the formatting; the mail app link holds plain text only.</span></div>`}
  </div>`;
}

function Reply({ app, onDone }) {
  const [text, setText] = useState('');
  const [read, setRead] = useState(null);
  const [picks, setPicks] = useState([]);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call('readCertReply', text);
      setRead(r); setPicks(r.items.map((x) => ({ ...x, on: true })));
      if (!r.items.length) toast('No decisions found. Each answer needs a kernel version or device name on its line, or right under the quoted question.');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const apply = async () => {
    const chosen = picks.filter((x) => x.on);
    setBusy(true);
    try {
      const r = await call('applyCertReply', chosen);
      toast(`${plural(r.changed, 'record')} updated from the cert team's reply${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}.`, 'ok');
      app && app.refresh && app.refresh();
      setText(''); setRead(null); setPicks([]); onDone && onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const set = (i, patch) => setPicks(picks.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return html`<div>
    <p class="muted small" style="margin-top:0">Paste the certifications team's answer, with your questions quoted or not. Each answer is matched to approvals by kernel version, device, platform, bundle and brand. Nothing changes until you press Apply, and every change keeps a dated note quoting the team.</p>
    <textarea class="input" rows="9" style="width:100%" placeholder="e.g. ARC Bundle 3 Visa kernel 0301: renewal submitted, expected March 2027. JCB 1.6: cannot be renewed, scheme mandate, moving to 0202." value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="row mt"><button class="btn primary" disabled=${busy || !text.trim()} onClick=${go}><${Icon} name="check" /> Read the reply</button>${busy ? html`<${Spinner} />` : null}</div>
    ${read ? html`
      ${picks.length ? html`<table class="mt"><thead><tr><th></th><th>Their answer</th><th>Applies to</th><th>Decision</th></tr></thead><tbody>
        ${picks.map((x, i) => html`<tr><td><input type="checkbox" checked=${x.on} onChange=${(e) => set(i, { on: e.target.checked })} /></td>
          <td class="small">"${x.line}"${x.replacement ? html`<div class="faint">Replacement kernel ${x.replacement}</div>` : null}${x.date ? html`<div class="faint">Date ${fmtDate(x.date)}</div>` : null}</td>
          <td class="small"><b>${x.summary}</b><div class="muted">${plural(x.ids.length, 'approval')}: ${x.devices}</div></td>
          <td><${Select} value=${x.decision} onChange=${(v) => set(i, { decision: v })} options=${Object.entries(read.decisions).map(([value, label]) => ({ value, label }))} /></td></tr>`)}
      </tbody></table>
      <div class="row mt"><button class="btn primary" disabled=${busy || !picks.some((x) => x.on)} onClick=${apply}>Apply ${plural(picks.filter((x) => x.on).length, 'decision')}</button></div>` : null}
      ${read.unread.length ? html`<div class="callout warn mt"><b>Not matched to any approval</b> (add a kernel version or device name and read again):<ul>${read.unread.map((l) => html`<li class="small">${l}</li>`)}</ul></div>` : null}` : null}
  </div>`;
}

function Status({ app }) {
  const [s] = useLoad(() => call('certStatus'), [app && app.version]);
  const [find, setFind] = useState('');
  const [only, setOnly] = useState('');
  if (!s) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = s.rows.filter((r) => (!only || r.status === only) && words.every((w) => `${r.platform} ${r.bundle} ${r.kind} ${r.kernel} ${r.devices}`.toLowerCase().includes(w)));
  return html`<div>
    <div class="row wrap">${Object.entries(s.statuses).filter(([k]) => s.counts[k]).map(([k, l]) => html`<button class=${`chip ${only === k ? 'on' : ''}`} onClick=${() => setOnly(only === k ? '' : k)}><span class=${`pill ${PILL[k]}`}>${s.counts[k]}</span> ${l}</button>`)}</div>
    <input class="input mt" style="width:100%" placeholder="Find a device, kernel, bundle or brand" value=${find} onInput=${(e) => setFind(e.target.value)} />
    <div style="max-height:52vh;overflow:auto" class="mt"><table><thead><tr><th>Status</th><th>Platform / bundle</th><th>Approval</th><th>Kernel</th><th>Expiry</th><th>Devices</th></tr></thead><tbody>
      ${rows.slice(0, 400).map((r) => html`<tr><td><span class=${`pill ${PILL[r.status]}`}>${r.statusText}</span>${r.note ? html`<div class="faint small" title=${r.note}>Cert team note</div>` : null}</td>
        <td>${[r.platform, r.bundle].filter(Boolean).join(' ') || html`<span class="faint">—</span>`}</td><td>${r.kind}</td>
        <td>${r.kernel ? html`<b>${r.kernel}</b>${r.kernelRecorded ? '' : html`<div class="faint small">from bundle page</div>`}` : /L2/.test(r.category) ? html`<span class="bad small">not known</span>` : html`<span class="faint">—</span>`}</td>
        <td>${r.expiry ? fmtDate(r.expiry) : '—'}</td><td class="small">${r.devices}</td></tr>`)}
    </tbody></table></div>
    ${rows.length > 400 ? html`<div class="faint small mt">Showing 400 of ${rows.length} groups. Narrow with the search or a status.</div>` : null}
  </div>`;
}
