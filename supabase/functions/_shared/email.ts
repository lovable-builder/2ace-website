// Sends mail through Resend. Without RESEND_API_KEY it logs and skips, so nothing breaks before setup.
const FROM = Deno.env.get('EMAIL_FROM') ?? '2ACE <onboarding@resend.dev>';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type Attachment = { filename: string; content: string };   // content is base64
export async function sendEmail(o: { to: string | string[]; subject: string; html: string; replyTo?: string; attachments?: Attachment[] }) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) { console.log('email skipped (no RESEND_API_KEY):', o.subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: o.to, subject: o.subject, html: o.html, reply_to: o.replyTo, ...(o.attachments?.length ? { attachments: o.attachments } : {}) }),
    });
    if (!r.ok) { console.error('resend error', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('resend failed', e); return false; }
}

// Simple branded wrapper so every email looks the same.
export function layout(title: string, body: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0B0C0E">
  <div style="font-weight:800;font-size:22px;letter-spacing:.02em;margin-bottom:20px">2ACE</div>
  <h1 style="font-size:22px;margin:0 0 14px">${esc(title)}</h1>${body}
  <p style="margin-top:28px;font-size:12px;color:#666">2ACE sp. z o.o., ul. Ostrobramska 101A lok. 301, 04-041 Warszawa. NIP 1133212948. Tel. +48 608 180 946. Questions? Reply to this email.</p></div>`;
}
