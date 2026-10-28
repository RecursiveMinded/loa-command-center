'use strict';
// Local AI assistant. Talks to a model running on this PC, either Ollama
// (default, e.g. Google's free Gemma 3) or any OpenAI-compatible local server
// (LM Studio, llama.cpp, Jan). Nothing is sent to the internet.
//
// The rules engine makes the decisions; the model explains them, answers
// questions about the portfolio, drafts messages, and helps read unusual LOAs.
// Every feature has a no-AI fallback so the app is fully usable without it.

const { formatDate } = require('./dates');
const { daysRemaining } = require('./lifecycle');

const SYSTEM = `You are the certification program manager inside a desktop app that tracks payment-terminal Letters of Approval (LOAs): EMV Level 1 and Level 2, PCI PTS, TQM, by device and card brand.
Rules:
- Use ONLY the data provided in the conversation. If something is not in the data, say you do not know.
- Never invent dates, approval numbers, owners, or devices.
- Be brief and practical: lead with what to do, then why. Use short bullet points.
- Distinguish expired, due soon, renewal in progress, restricted/final, and end-of-life (accepted, not renewing) approvals.`;

// Industry background, so answers and clean-up advice follow how payment
// device certification actually works.
const INDUSTRY = `How payment device certification works:
- Level 1 (EMVCo) covers the physical interfaces: L1 Contact (card slot, ISO 7816, usually ~4 years) and L1 Contactless (RF reader, ISO 14443, usually ~3 years). Hardware changes such as an antenna or NFC chip swap can need new testing.
- Level 2 covers the kernel software: one EMVCo L2 Contact approval per terminal (~3 years) and an L2 Contactless approval from each card brand (Visa, Mastercard, Amex, Discover, JCB, UnionPay, Interac), each with its own expiry, usually 2-3 years.
- L2 rests on L1 for the same interface: if the L1 expires or is not renewed, the L2 approvals that depend on it are at risk.
- Mastercard TQM (Terminal Quality Management) is a hardware/manufacturing conformity statement per device; a valid TQM is required to obtain and keep Mastercard L2 approvals.
- PCI PTS covers tamper security and key management. If it expires, no new units can be manufactured or key-injected, even while EMV approvals are valid. PTS versions (v4, v5, v6, v7) have their own sunset dates.
- Each L2 approval is for one kernel build: kernel name, version and often a checksum (e.g. "PAYPASS_L2 v04.04", "EMV_C5 04.04.00, checksum 23EC"), tested with a given entry point. A new kernel version needs its own L2 approval; a letter with a different kernel than the record is a new kernel, not a plain renewal. Level 3 partners need the exact kernel version alongside the approval number.
- A hardware version (CL1, CL2, CL3) is a revision of the device: physical chip components changed, often because PCI or a new standard required it (for example a new antenna). A device name without a suffix is the first version (CL1). Each version has its own L1 Contactless, TQM and L2 Contactless approvals; PCI PTS and the contact approvals (L1 and L2 Contact) are shared by all versions. The newest version keeps the device certifiable; older versions age out and are usually not renewed.
- Contact interface revisions are marked CT1, CT2 in product configuration bulletins; each row of a bulletin is one approved interface with its own LoA reference, expiry and TQM label.
- One LOA can certify a family of devices that share the same hardware components (reader, chip) and kernel version. Read the list of products on each letter and apply it to every device named.
- Customers may keep running devices on expired LOAs, but they may be unable to upgrade kernels or stay PCI compliant until they move to a version that meets the latest standards.
- An expired LOA closes the device to new deployments; units already in the field are usually grandfathered. A certification can be accepted as end of life when it will not be renewed (e.g. CL1 replaced by CL2).
- Renewal paths: administrative renewal (no changes), derivative/family, delta testing (minor changes), full recertification (major changes), or end of life.
- Plan on an 18-month horizon: decide the renewal path 12-18 months out, escalate to Product Management at 12 months, to Client Solutions/account teams at 6 months, and to executives at 3 months.
- Level 3 (acquirer/processor integration) is done by partners and relies on the vendor's L1 and L2 approval numbers.`;

/** The system prompt: the rules, the industry background, and the organisation's own rules file. */
function systemPrompt(rules) {
  const own = String(rules || '').trim();
  return `${SYSTEM}\n\n${INDUSTRY}${own ? `\n\nThe organisation's own rules and context (follow these; they override general practice):\n${own.slice(0, 8000)}` : ''}`;
}

function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch (_) { return false; }
}

class LocalAI {
  constructor(getSettings, fetchImpl = globalThis.fetch) {
    this.getSettings = getSettings;
    this.fetch = fetchImpl;
  }

  cfg() {
    return { provider: 'off', baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', apiKey: '', ...(this.getSettings().ai || {}) };
  }

  async request(path, body, { timeoutMs = 120000, method = 'POST' } = {}) {
    const c = this.cfg();
    if (!isLocalUrl(c.baseUrl)) throw new Error('For privacy, the AI address must be on this computer or your local network.');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(c.baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`AI server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The AI model took too long to answer.');
      if (/fetch failed|ECONNREFUSED/i.test(String(e.message || e))) throw new Error(`No AI server is running at ${c.baseUrl}. Start Ollama (or your local model server) and try again.`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  async status() {
    const c = this.cfg();
    if (c.provider === 'off') return { enabled: false, available: false, models: [], message: 'AI assistant is off. The rules engine still builds your action plan.' };
    try {
      if (c.provider === 'ollama') {
        const r = await this.request('/api/tags', null, { method: 'GET', timeoutMs: 4000 });
        const models = (r.models || []).map((m) => m.name);
        const has = models.some((m) => m === c.model || m.split(':')[0] === c.model.split(':')[0]);
        return { enabled: true, available: has, models, message: has ? `Connected to ${c.model}` : `Ollama is running but the model "${c.model}" is not installed. Run: ollama pull ${c.model}` };
      }
      const r = await this.request('/v1/models', null, { method: 'GET', timeoutMs: 4000 });
      const models = (r.data || []).map((m) => m.id);
      return { enabled: true, available: true, models, message: `Connected (${models.length} model${models.length === 1 ? '' : 's'})` };
    } catch (e) {
      return { enabled: true, available: false, models: [], message: e.message };
    }
  }

  async chat(messages, { json = false, temperature = 0.2 } = {}) {
    const c = this.cfg();
    if (c.provider === 'off') throw new Error('AI assistant is off. Turn it on in Settings.');
    const all = [{ role: 'system', content: systemPrompt(this.getSettings().aiRules) }, ...messages];
    if (c.provider === 'ollama') {
      const r = await this.request('/api/chat', { model: c.model, messages: all, stream: false, format: json ? 'json' : undefined, options: { temperature } });
      return (r.message && r.message.content) || '';
    }
    const r = await this.request('/v1/chat/completions', { model: c.model, messages: all, temperature, ...(json ? { response_format: { type: 'json_object' } } : {}) });
    return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
  }

  // -------------------------------------------------------------- features
  async briefing(analysis) {
    const fallback = templateBriefing(analysis);
    if (this.cfg().provider === 'off') return { text: fallback, ai: false };
    try {
      const text = await this.chat([{ role: 'user', content: `${portfolioContext(analysis)}\n\nWrite this week's briefing for the certification manager: the 3-5 most important things to do now and why, then one line on overall portfolio health. Under 180 words.` }]);
      return { text: text.trim() || fallback, ai: true };
    } catch (e) {
      return { text: fallback, ai: false, error: e.message };
    }
  }

  async ask(question, analysis, records) {
    if (this.cfg().provider === 'off') return { text: answerWithoutAi(question, analysis, records), ai: false };
    const rel = relevantRecords(question, records, analysis.asOf);
    const content = `${portfolioContext(analysis)}\n\nRelevant records (device | platform | brand | approval | expires | days left | owner | stage):\n${rel.map((r) => recordLine(r, analysis.asOf)).join('\n') || '(none matched)'}\n\nQuestion: ${question}`;
    try {
      return { text: (await this.chat([{ role: 'user', content }])).trim(), ai: true, records: rel.map((r) => r.id) };
    } catch (e) {
      return { text: answerWithoutAi(question, analysis, records), ai: false, error: e.message };
    }
  }

  /**
   * Data clean-up: the deterministic checks, explained and prioritised by the
   * model when it is on. Without AI the checks are listed as they are.
   */
  async dataReview(issues, analysis) {
    const list = issues.map((i) => `- [${i.severity}] ${i.title}. ${i.detail} Fix: ${i.fix} Examples: ${i.examples.join('; ')}`).join('\n');
    const fallback = issues.length ? `Data checks found ${issues.length} thing${issues.length === 1 ? '' : 's'} to look at:\n${issues.map((i) => `• ${i.title}. ${i.fix}`).join('\n')}` : 'The data checks found nothing to clean up.';
    if (this.cfg().provider === 'off' || !issues.length) return { text: fallback, ai: false };
    try {
      const text = await this.chat([{ role: 'user', content: `${portfolioContext(analysis)}\n\nData integrity findings from the app's checks:\n${list}\n\nAct as the certification data steward. Recommend the clean-up in order of risk: what to fix first and why, which findings may be legitimate (say so), and any conflict that needs a decision. Use only these findings; do not invent records. Under 220 words.` }]);
      return { text: text.trim() || fallback, ai: true };
    } catch (e) {
      return { text: fallback, ai: false, error: e.message };
    }
  }

  async draftEmail(records, { purpose = 'renewal', asOf, to = '' } = {}) {
    const list = records.map((r) => `- ${r.device}${r.platform ? ` (${r.platform}${r.bundle ? ` ${r.bundle}` : ''})` : ''}: ${r.scheme} ${r.category}, approval ${r.approval_number || 'n/a'}, expires ${formatDate(r.expiry_date) || 'unknown'}`).join('\n');
    const fallback = templateEmail(records, purpose, list, to);
    if (this.cfg().provider === 'off') return { text: fallback, ai: false };
    try {
      const text = await this.chat([{ role: 'user', content: `Draft a short professional email${to ? ` to ${to}` : ''} for purpose "${purpose}" about these approvals. Ask for renewal status/timeline and the updated LOA. Keep the list exactly as given. No internal file paths.\n${list}` }], { temperature: 0.3 });
      return { text: text.trim() || fallback, ai: true };
    } catch (e) {
      return { text: fallback, ai: false, error: e.message };
    }
  }

  /**
   * Ask the model to fill fields the rule-based reader could not find. Every
   * suggested value must appear verbatim in the letter text, so the model can
   * help locate facts but can never introduce them.
   */
  async assistExtract(letterText, missing) {
    const prompt = `From this Letter of Approval text, return JSON with keys: issuer, category (one of: EMV L1 Contact, EMV L1 Contactless, EMV L2 Contact, EMV L2 Contactless, PCI PTS, TQM, Other), approval_number, products (array of device names), issue_date, expiry_date. Copy values exactly as written in the text. Use null when absent.\n\nTEXT:\n${letterText.slice(0, 6000)}`;
    const raw = await this.chat([{ role: 'user', content: prompt }], { json: true, temperature: 0 });
    let obj;
    try { obj = JSON.parse(raw.replace(/^```json|```$/g, '').trim()); } catch (_) { throw new Error('The AI answer was not valid JSON'); }
    const { parseDate } = require('./dates');
    const flat = letterText.replace(/\s+/g, ' ').toLowerCase();
    const inText = (v) => v && flat.includes(String(v).replace(/\s+/g, ' ').toLowerCase());
    const out = {};
    for (const k of missing || ['approval_number', 'products', 'issue_date', 'expiry_date', 'category']) {
      const v = obj[k];
      if (v == null) continue;
      if (k === 'products' && Array.isArray(v)) {
        const ok = v.filter(inText);
        if (ok.length) out.products = ok;
      } else if (k.endsWith('_date')) {
        if (inText(v) && parseDate(v)) out[k] = parseDate(v);
      } else if (k === 'category') {
        out.category = v;
      } else if (inText(v)) out[k] = String(v);
    }
    return out;
  }
}

// ------------------------------------------------------------------ helpers
function portfolioContext(analysis) {
  const s = analysis.summary;
  const acts = analysis.actions.filter((a) => a.status === 'open').slice(0, 25)
    .map((a) => `- [${a.priorityLabel}] ${a.title} (due ${a.due || 'n/a'}): ${a.why}`).join('\n');
  const brands = Object.entries(s.byScheme).map(([k, v]) => `${k}: ${v.total} total, ${v.expired} expired, ${v.due90} due ≤90d, ${v.due365} due ≤12mo`).join('; ');
  return `Today is ${analysis.asOf}.
Portfolio: ${s.total} certifications; health ${s.healthScore}/100; expired unresolved ${s.expiredOpen}; due ≤90 days ${s.due90}; due ≤6 months ${s.due180}; due ≤12 months ${s.due365}; missing dates ${s.missing}; LOA on file ${s.evidencePct}%; owners assigned ${s.ownerPct}%; LOAs waiting for review ${s.inboxPending}.
By brand: ${brands}
Action plan from the rules engine:
${acts || '- none'}`;
}

function recordLine(r, asOf) {
  const d = daysRemaining(r, asOf);
  return [r.device, r.platform, r.scheme, r.category, r.expiry_date || 'no date', d == null ? '' : d, r.owner || 'unassigned', r.eol ? `end of life (${r.eol})` : r.stage || 'auto'].join(' | ');
}

function relevantRecords(q, records, asOf, limit = 60) {
  const words = String(q).toLowerCase().split(/[^a-z0-9/]+/).filter((w) => w.length > 1);
  const monthIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].findIndex((m) => words.some((w) => w.startsWith(m)));
  const scored = records.filter((r) => !r.archived).map((r) => {
    const hay = `${r.device} ${r.platform} ${r.bundle} ${r.scheme} ${r.category} ${r.owner} ${r.customer} ${r.market}`.toLowerCase();
    let s = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (monthIdx >= 0 && r.expiry_date && Number(r.expiry_date.slice(5, 7)) === monthIdx + 1) s += 2;
    const d = daysRemaining(r, asOf);
    if (/expir|due|soon|urgent|risk|next/.test(q.toLowerCase()) && d != null && d <= 365) s += 1;
    return { r, s, d };
  }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || (a.d ?? 1e9) - (b.d ?? 1e9));
  return scored.slice(0, limit).map((x) => x.r);
}

function templateBriefing(analysis) {
  const s = analysis.summary;
  const open = analysis.actions.filter((a) => a.status === 'open');
  const top = open.slice(0, 5);
  const lines = [
    `Portfolio health is ${s.healthScore}/100 across ${s.total} certifications.`,
    s.expiredOpen ? `${s.expiredOpen} expired approval${s.expiredOpen === 1 ? ' needs' : 's need'} a decision.` : 'Nothing is expired without a decision.',
    `${s.due90} expire within 90 days and ${s.due365} within 12 months.`,
    '',
    top.length ? 'Do next:' : 'No open actions. Nice work.',
    ...top.map((a) => `• ${a.title}`),
  ];
  return lines.join('\n');
}

function answerWithoutAi(question, analysis, records) {
  const rel = relevantRecords(question, records, analysis.asOf, 15);
  if (!rel.length) return `${templateBriefing(analysis)}\n\nTurn on the local AI assistant in Settings for free-form answers.`;
  return `Matching records:\n${rel.map((r) => `• ${r.device} · ${r.scheme} ${r.category}: expires ${formatDate(r.expiry_date) || 'unknown'}${r.owner ? `, owner ${r.owner}` : ''}`).join('\n')}\n\nTurn on the local AI assistant in Settings for free-form answers.`;
}

function templateEmail(records, purpose, list, to) {
  return `Subject: ${purpose === 'renewal' ? 'Renewal status request' : 'Certification follow-up'}: ${records.length} approval${records.length === 1 ? '' : 's'}

Hello${to ? ` ${to}` : ''},

Could you share the renewal status and expected timeline for the following approvals, and send the updated Letters of Approval once available?

${list}

Thank you,`;
}

module.exports = { LocalAI, portfolioContext, relevantRecords, templateBriefing, isLocalUrl, SYSTEM, INDUSTRY, systemPrompt };
