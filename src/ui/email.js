// Emails dropped in the LOA inbox: Outlook .msg and standard .eml files.
// The attachments are what usually carry the LOAs; the message text is read
// too when it looks like an approval notice.
import PostalMime from 'postal-mime';
import MsgReaderModule from '@kenjiuno/msgreader';

const MsgReader = MsgReaderModule.default || MsgReaderModule;

const htmlToText = (h) => {
  try {
    const doc = new DOMParser().parseFromString(String(h || ''), 'text/html');
    doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4').forEach((b) => b.append('\n'));
    return doc.body ? doc.body.textContent || '' : '';
  } catch (_) { return String(h || '').replace(/<[^>]+>/g, ' '); }
};

const extOf = (name) => String(name || '').toLowerCase().split('.').pop();
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp'];

/**
 * Read an email into { subject, from, date, text, attachments: [{ name, bytes, inline }] }.
 * Embedded emails (a forwarded message attached as an item) come back as .msg attachments.
 */
export async function readEmail(name, bytes) {
  if (extOf(name) === 'msg') {
    const reader = new MsgReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const data = reader.getFileData();
    if (data.error) throw new Error(`Not a readable Outlook message: ${data.error}`);
    const attachments = [];
    for (const a of data.attachments || []) {
      try {
        const got = reader.getAttachment(a);
        const fname = got.fileName || a.fileName || a.name || 'attachment';
        attachments.push({ name: a.innerMsgContent && !/\.msg$/i.test(fname) ? `${fname}.msg` : fname, bytes: got.content, inline: !!(a.attachmentHidden || a.pidContentId) });
      } catch (_) { /* unreadable attachment: skipped */ }
    }
    return { subject: data.subject || '', from: data.senderName || data.senderEmail || '', date: data.messageDeliveryTime || data.clientSubmitTime || '', text: data.body || htmlToText(data.bodyHtml), attachments };
  }
  const mail = await PostalMime.parse(bytes);
  return {
    subject: mail.subject || '',
    from: (mail.from && (mail.from.name || mail.from.address)) || '',
    date: mail.date || '',
    text: mail.text || htmlToText(mail.html),
    attachments: (mail.attachments || []).map((a) => ({
      name: a.filename || (a.mimeType === 'message/rfc822' ? 'attached message.eml' : 'attachment'),
      bytes: a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content),
      inline: a.disposition === 'inline' || !!a.contentId,
    })),
  };
}

/** Text that reads like an approval notice rather than "please find attached". */
export function looksLikeApproval(text) {
  const t = String(text || '');
  return t.replace(/\s+/g, ' ').length > 150 && /letter\s+of\s+approval|approval\s+(?:number|no\b|id)|\bLoA\b|expir\w*\s+date|renewal\s+date|valid\s+until/i.test(t);
}

/**
 * The files an email contributes to the inbox: its LOA attachments, and its
 * text as a .txt letter when that text looks like an approval notice.
 * Inline pictures (logos, signatures) are left out.
 */
export function emailFiles(mail, isLoa) {
  const files = [];
  const skipped = [];
  for (const a of mail.attachments) {
    const ext = extOf(a.name);
    if ((a.inline && IMAGE.includes(ext)) || (IMAGE.includes(ext) && a.bytes.length < 20000)) continue;
    if (isLoa(a.name)) files.push(new File([a.bytes], a.name));
    else skipped.push(a.name);
  }
  const text = String(mail.text || '').trim();
  if (text && looksLikeApproval(text)) {
    const head = [mail.subject && `Subject: ${mail.subject}`, mail.from && `From: ${mail.from}`, mail.date && `Date: ${mail.date}`].filter(Boolean).join('\n');
    const base = (mail.subject || 'Email').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Email';
    files.unshift(new File([`${head}\n\n${text}`], `${base} (email text).txt`));
  }
  return { files, skipped };
}
