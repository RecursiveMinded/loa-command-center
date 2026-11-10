// Team emails in the LOA inbox: what a team member wrote, read against the register.
// Their updates become decisions to confirm, what the app cannot settle becomes a
// question for you, their questions get answers from the register, and what they left
// out becomes a follow-up reply to copy or open in the mail app.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, useLoad, Spinner, toast, toastError, Select, fmtDate, fmtWhen, plural } from './lib.js';
import { call } from './api.js';

export function TeamMail({ app }) {
  const [status, setStatus] = useState('open');
  const [list, reload] = useLoad(() => call('listTeamEmails', { status }), [app.version, status]);
  const [known] = useLoad(() => call('knownDevices').catch(() => []), []);
  return html`<div>
    <div class="row between wrap"><p class="muted small" style="margin:0">Drop an email from a team member (.msg or .eml) or paste its text. I match what they say to your approvals, ask you what I cannot settle, answer their questions from the register, and draft a reply asking for what they left out. Nothing changes until you apply.</p>
      <div class="seg">${[['open', 'Open'], ['done', 'Done']].map(([k, l]) => html`<button class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${l}</button>`)}</div></div>
    ${!list ? html`<div class="row mt"><${Spinner} /> Reading…</div>`
      : !list.length ? html`<div class="card mt"><div class="empty"><${Icon} name="mail" /><h3>${status === 'open' ? 'No team emails waiting' : 'Nothing done yet'}</h3><div>Drop an email above, or use Paste text and choose "Read as a team email".</div></div></div>`
        : list.map((m) => html`<${MailCard} key=${m.id} m=${m} app=${app} known=${known || []} onChanged=${() => { reload(); app.refresh(); }} />`)}
  </div>`;
}

function MailCard({ m: first, app, known, onChanged }) {
  const [m, setM] = useState(first);
  useEffect(() => setM(first), [first]);
  const r = m.read;
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  const [reply, setReply] = useState(null); // edited reply text; null follows the draft
  const pick = (it) => ({ on: !it.applied && !it.conflict, decision: it.decision, ...(picks[it.key] || {}) });
  const setPick = (key, patch) => setPicks({ ...picks, [key]: { ...(picks[key] || {}), ...patch } });
  const chosen = r.items.filter((it) => !it.applied && pick(it).on && it.ids.length);
  const aiOn = app.settings && app.settings.ai && app.settings.ai.provider && app.settings.ai.provider !== 'off';

  const answer = async (key, value) => {
    try { setM(await call('answerTeamEmail', m.id, key, value)); } catch (e) { toastError(e); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const res = await call('applyTeamEmail', m.id, chosen.map((it) => ({ key: it.key, decision: pick(it).decision, ids: it.ids, line: it.line, replacement: it.replacement, date: it.date })));
      toast(`${plural(res.changed, 'record')} updated from ${m.from || 'the email'}${res.skipped.length ? `; ${res.skipped.length} skipped` : ''}. Each keeps a dated note quoting it.`, 'ok');
      onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const close = async (done) => { try { await call('closeTeamEmail', m.id, done); onChanged(); } catch (e) { toastError(e); } };
  const askAi = async () => {
    setBusy(true);
    try { await call('aiReadTeamEmail', m.id); toast('The AI read it too: its summary and questions are added.', 'ok'); onChanged(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const text = reply != null ? reply : r.followUp.text;
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast('Reply copied. Paste it into your reply in Outlook.', 'ok'); } catch (e) { toastError(e); } };
  const mail = () => { location.href = `mailto:${encodeURIComponent(r.followUp.to || '')}?subject=${encodeURIComponent(r.followUp.subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`; };
  const open = r.forYou.filter((f) => !f.info && !f.answer);

  return html`<div class="card mt teammail">
    <div class="hd"><div class="grow"><h3 style="margin:0"><${Icon} name="mail" /> ${m.subject || '(no subject)'}</h3>
      <div class="muted small">From <b>${m.from || 'unknown sender'}</b>${m.date ? ` · ${fmtWhen(m.date)}` : ''}${m.attachments.length ? ` · ${plural(m.attachments.length, 'attachment')} read in the inbox` : ''}${m.status === 'done' ? ' · done' : ''}</div></div>
      <div class="row">${aiOn ? html`<button class="btn sm" disabled=${busy} onClick=${askAi} title="Ask the local AI for a summary and any questions the rules missed"><${Icon} name="spark" /> Ask AI too</button>` : null}
        <button class="btn sm" onClick=${() => setShowText(!showText)}>${showText ? 'Hide email' : 'Show email'}</button>
        ${m.status === 'open' ? html`<button class="btn sm" onClick=${() => close(true)} title="Nothing more to do on this email">Done</button>` : html`<button class="btn sm" onClick=${() => close(false)}>Open again</button>`}</div></div>
    <div class="bd">
      <div class=${`callout ${open.length ? 'warn' : 'good'}`}>${m.ai && m.ai.summary ? html`<span class="faint small">AI · </span>` : null}${r.summary}</div>
      ${showText ? html`<div class="excerpt mt" style="max-height:30vh;white-space:pre-wrap">${m.text}</div>` : null}

      ${r.forYou.length ? html`<h4 class="mt">Questions for you</h4>
        ${r.forYou.map((f) => html`<${Question} key=${f.key} f=${f} known=${known} onAnswer=${(v) => answer(f.key, v)} />`)}` : null}

      ${r.items.length ? html`<h4 class="mt">What ${firstOf(m.from)} says</h4>
        <table><thead><tr><th></th><th>Their words</th><th>Applies to</th><th>Decision</th></tr></thead><tbody>
        ${r.items.map((it) => html`<tr class=${it.applied ? 'faint' : ''}>
          <td>${it.applied ? html`<span class="pill good">Applied</span>` : html`<input type="checkbox" aria-label="Apply this decision" checked=${pick(it).on} onChange=${(e) => setPick(it.key, { on: e.target.checked })} />`}</td>
          <td class="small">"${it.line}"${it.dateLabel ? html`<div class="faint">Date ${it.dateLabel}</div>` : null}${it.replacement ? html`<div class="faint">Replacement kernel ${it.replacement}</div>` : null}${it.fromAnswer ? html`<div class="faint">From your answer: ${it.fromAnswer}</div>` : null}${it.conflict ? html`<div class="bad">${it.conflict}</div>` : null}</td>
          <td class="small"><b>${it.summary}</b><div class="muted">${plural(it.ids.length, 'approval')}: ${it.devices}</div></td>
          <td>${it.applied ? it.label : html`<${Select} value=${pick(it).decision} onChange=${(v) => setPick(it.key, { decision: v })} options=${DECISIONS} />`}</td></tr>`)}
        </tbody></table>
        ${chosen.length ? html`<div class="row mt"><button class="btn primary" disabled=${busy} onClick=${apply}><${Icon} name="check" /> Apply ${plural(chosen.length, 'decision')}</button><span class="faint small">Each record keeps a dated note quoting ${firstOf(m.from)}.</span></div>` : null}` : null}

      ${r.theyAsked.length ? html`<h4 class="mt">${firstOf(m.from)} asked you</h4>
        ${r.theyAsked.map((q) => html`<div class="mt-s"><div class="small"><b>"${q.text}"</b></div>
          <textarea class="input" rows=${Math.min(5, Math.max(2, String(q.answer || '').split('\n').length))} style="width:100%" aria-label="Your answer"
            placeholder=${q.suggested ? '' : 'Not found in the register. Type your answer for the reply.'} value=${q.answer} onChange=${(e) => answer(q.key, e.target.value)}></textarea>
          ${q.suggested ? html`<div class="faint small">Suggested from the register. Edit it before sending.</div>` : null}</div>`)}` : null}

      <h4 class="mt">Reply to ${firstOf(m.from)}${r.followUp.count ? html` <span class="pill info">${plural(r.followUp.count, 'follow-up question')}</span>` : null}</h4>
      <textarea class="input" rows="10" style="width:100%" aria-label="Reply to send" value=${text} onInput=${(e) => setReply(e.target.value)}></textarea>
      <div class="row mt"><button class="btn primary" onClick=${copy}><${Icon} name="file" /> Copy reply</button>
        <button class="btn" onClick=${mail}><${Icon} name="mail" /> Open in mail app</button>
        ${reply != null ? html`<button class="btn ghost sm" onClick=${() => setReply(null)} title="Go back to the draft, which follows your answers above">Use the draft again</button>` : html`<span class="faint small">The draft updates as you answer the questions above.</span>`}</div>
    </div>
  </div>`;
}

const DECISIONS = [
  { value: 'renew', label: 'Renewal coming' }, { value: 'letexpire', label: 'Letting it expire' }, { value: 'eol', label: 'End of life: no longer certified' },
  { value: 'waiver', label: 'Customers request a waiver' }, { value: 'mandate', label: 'Cannot be renewed (scheme mandate)' },
];
const firstOf = (from) => { const s = String(from || '').replace(/<[^>]*>/g, '').trim(); if (!s) return 'They'; const p = s.includes(',') ? s.split(',').map((x) => x.trim()).reverse() : s.split(/\s+/); return p[0].split('@')[0]; };

function Question({ f, known, onAnswer }) {
  const [v, setV] = useState(f.answer && f.answer !== 'new' ? f.answer : '');
  if (f.info) return html`<div class="callout warn small mt-s"><${Icon} name="info" /> ${f.text}</div>`;
  const listId = `known-${f.key.replace(/[^a-z0-9]/gi, '')}`;
  return html`<div class=${`ask mt-s ${f.answer && !f.unmatched ? 'answered' : ''}`}>
    <div class="small">${f.answer && !f.unmatched ? html`<${Icon} name="check" /> ` : null}${f.text}</div>
    ${f.kind === 'scope' ? html`<div class="row wrap mt-s">${f.options.map((o) => html`<button class=${`btn sm ${f.answer === o.value ? 'primary' : ''}`} onClick=${() => onAnswer(o.value)}>${o.label}</button>`)}</div>`
      : html`<div class="row wrap mt-s">
        <input class="input grow" list=${f.kind === 'device' ? listId : undefined} aria-label="Your answer" placeholder=${f.placeholder || 'Your answer'} value=${v} onInput=${(e) => setV(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && v.trim()) onAnswer(v.trim()); }} />
        ${f.kind === 'device' ? html`<datalist id=${listId}>${known.slice(0, 500).map((d) => html`<option value=${d} />`)}</datalist>` : null}
        <button class="btn sm" disabled=${!v.trim()} onClick=${() => onAnswer(v.trim())}>Save</button>
        ${(f.options || []).map((o) => html`<button class=${`btn sm ${f.answer === o.value ? 'primary' : ''}`} onClick=${() => onAnswer(o.value)}>${o.label}</button>`)}
        ${f.answer ? html`<button class="btn ghost sm" onClick=${() => { setV(''); onAnswer(''); }}>Clear</button>` : null}</div>
      ${f.unmatched ? html`<div class="bad small">That still matches no approval. Name the device, brand or kernel version.</div>` : null}`}
  </div>`;
}
