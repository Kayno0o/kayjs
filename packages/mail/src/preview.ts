import type { SentMail } from './outbox'
import type { Address } from './types'
import { Elysia } from 'elysia'
import { outbox } from './outbox'

export const PREVIEW_PATH = '/_kay/mail'

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const HTML_SPECIAL = /[&<>"']/g

// The mail's own markup runs nothing and loads only images and fonts, so a link or a script in it never acts as the development site.
const MAIL_POLICY = 'sandbox allow-popups allow-popups-to-escape-sandbox; default-src \'none\'; img-src * data: cid:; style-src \'unsafe-inline\' *; font-src * data:'

const STYLE = `
body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#f6f6f4}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 16px}
a{color:#1d4ed8}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e5e0;vertical-align:top}
th{font-weight:600;color:#555;white-space:nowrap}
.empty{padding:32px;text-align:center;color:#555;background:#fff}
iframe{width:100%;height:70vh;border:1px solid #e5e5e0;background:#fff}
pre{white-space:pre-wrap;background:#fff;border:1px solid #e5e5e0;padding:12px;margin:0}
h2{font-size:15px;margin:24px 0 8px}
`

function escape(text: string): string {
  return text.replace(HTML_SPECIAL, char => HTML_ESCAPES[char]!)
}

function shown(addresses: Address | Address[] | undefined): string {
  const all = addresses === undefined ? [] : Array.isArray(addresses) ? addresses : [addresses]

  return escape(all.map(address => typeof address === 'string' ? address : `${address.name} <${address.address}>`).join(', '))
}

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

function listPage(): Response {
  const mails = outbox.mails.toReversed()

  if (mails.length === 0)
    return page('Outbox', `<h1>Outbox</h1><p class="empty">No mail sent since the server started.</p>`)

  const rows = mails.map(mail => `<tr><td>${escape(mail.sentAt.toLocaleTimeString('en-GB'))}</td><td>${shown(mail.to)}</td><td><a href="${PREVIEW_PATH}/${mail.id}">${escape(mail.subject)}</a></td></tr>`)

  return page('Outbox', `<h1>Outbox</h1><table><thead><tr><th>Sent</th><th>To</th><th>Subject</th></tr></thead><tbody>${rows.join('')}</tbody></table>`)
}

function mailPage(mail: SentMail): Response {
  const headers: [string, string][] = [
    ['From', shown(mail.from)],
    ['To', shown(mail.to)],
    ...mail.cc.length > 0 ? [['Cc', shown(mail.cc)] as [string, string]] : [],
    ...mail.bcc.length > 0 ? [['Bcc', shown(mail.bcc)] as [string, string]] : [],
    ...mail.replyTo === undefined ? [] : [['Reply-To', shown(mail.replyTo)] as [string, string]],
    ['Subject', escape(mail.subject)],
    ['Sent', escape(mail.sentAt.toISOString())],
    ...Object.entries(mail.headers).map(([name, value]) => [escape(name), escape(value)] as [string, string]),
    ...mail.attachments.map(attachment => ['Attachment', escape(`${attachment.filename} (${attachment.contentType ?? 'unknown type'}, ${typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength} bytes)`)] as [string, string]),
  ]
  const html = mail.html === undefined ? '' : `<h2>Html</h2><iframe title="The mail's html" src="${PREVIEW_PATH}/${mail.id}/html"></iframe>`

  return page(mail.subject, `<p><a href="${PREVIEW_PATH}">Outbox</a></p><h1>${escape(mail.subject)}</h1><table><tbody>${headers.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join('')}</tbody></table>${html}<h2>Text</h2><pre>${escape(mail.text)}</pre>`)
}

const missing = (): Response => page('Not in the outbox', `<p><a href="${PREVIEW_PATH}">Outbox</a></p><p class="empty">This mail is no longer in the outbox: it keeps the last 500, and empties when the server restarts.</p>`, 404)

// The development server's view of the outbox: every mail sent since it started, newest first, each with its headers, html and text.
export const preview = new Elysia({ name: 'kayjs-mail-preview' })
  .get(PREVIEW_PATH, listPage)
  .get(`${PREVIEW_PATH}/:id`, ({ params }) => {
    const mail = outbox.find(params.id)

    return mail ? mailPage(mail) : missing()
  })
  .get(`${PREVIEW_PATH}/:id/html`, ({ params }) => {
    const html = outbox.find(params.id)?.html

    if (html === undefined)
      return missing()

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MAIL_POLICY } })
  })
