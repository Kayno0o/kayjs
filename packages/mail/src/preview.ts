import type { SentMail } from './outbox'
import type { Address, Attachment } from './types'
import { createHash } from 'node:crypto'
import { Elysia } from 'elysia'
import MailComposer from 'nodemailer/lib/mail-composer'
import { escapeHtml as escape } from './escape'
import { outbox } from './outbox'
import { nodemailerMessage } from './smtp'

export const PREVIEW_PATH = '/_kay/mail'

// The mail's own markup runs nothing and loads only images and fonts, so a link or a script in it never acts as the development site.
const MAIL_POLICY = 'sandbox allow-popups allow-popups-to-escape-sandbox; default-src \'none\'; img-src * data: cid:; style-src \'unsafe-inline\' *; font-src * data:'

// Reloads the list as each mail arrives.
const LIVE = `new EventSource('${PREVIEW_PATH}/events').onmessage=()=>location.reload()`

// The pages' own policy, which a site's narrower one, such as a `frame-src` naming only a map provider, would otherwise replace and leave the mail's frame blank.
const PAGE_POLICY = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(LIVE).digest('base64')}'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'`

// Gmail cuts a mail whose html passes this, behind a "View entire message" link.
const GMAIL_CLIP_BYTES = 102 * 1024
// Under Bun's idle timeout, so a quiet stream stays open.
const KEEPALIVE_MS = 5000
const PHONE_WIDTH = 375

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
iframe.phone{width:${PHONE_WIDTH}px;max-width:100%}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:0 0 16px}
.warning{color:#8a2c0d;font-weight:600}
.confirm{padding:16px;margin:0 0 16px;background:#fff;border:1px solid #e5e5e0}
button{font:inherit;padding:6px 12px;cursor:pointer}
pre{white-space:pre-wrap;background:#fff;border:1px solid #e5e5e0;padding:12px;margin:0}
h2{font-size:15px;margin:24px 0 8px}
`

function shown(addresses: Address | Address[] | undefined): string {
  const all = addresses === undefined ? [] : Array.isArray(addresses) ? addresses : [addresses]

  return escape(all.map(address => typeof address === 'string' ? address : `${address.name} <${address.address}>`).join(', '))
}

function page(title: string, body: string, status = 200, script = ''): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_POLICY } })
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function listPage(clearing: boolean): Response {
  const mails = outbox.mails.toReversed()
  const live = `<script>${LIVE}</script>`

  if (mails.length === 0)
    return page('Outbox', `<h1>Outbox</h1><p class="empty">No mail sent since the server started. Mails show here as they are sent.</p>`, 200, live)

  const count = `${mails.length} mail${mails.length === 1 ? '' : 's'}`
  const bar = clearing
    ? `<form class="confirm" method="post" action="${PREVIEW_PATH}/clear"><p>Clear the ${count} in the outbox? Their pages go with them.</p><div class="bar"><button type="submit">Clear ${count}</button><a href="${PREVIEW_PATH}">Cancel</a></div></form>`
    : `<div class="bar"><span>${count}, newest first</span><a href="${PREVIEW_PATH}?clear">Clear the outbox</a></div>`
  const rows = mails.map(mail => `<tr><td>${escape(mail.sentAt.toLocaleTimeString('en-GB'))}</td><td>${shown(mail.to)}</td><td><a href="${PREVIEW_PATH}/${mail.id}">${escape(mail.subject)}</a></td></tr>`)

  return page('Outbox', `<h1>Outbox</h1>${bar}<table><thead><tr><th>Sent</th><th>To</th><th>Subject</th></tr></thead><tbody>${rows.join('')}</tbody></table>`, 200, live)
}

function mailPage(mail: SentMail, phone: boolean): Response {
  const htmlBytes = mail.html === undefined ? 0 : Buffer.byteLength(mail.html)
  const clipped = htmlBytes > GMAIL_CLIP_BYTES ? ` <span class="warning">Gmail clips it: its html passes ${kilobytes(GMAIL_CLIP_BYTES)}</span>` : ''
  const size = `${kilobytes(htmlBytes + Buffer.byteLength(mail.text))}, html ${kilobytes(htmlBytes)}${clipped}`
  const headers: [string, string][] = [
    ['From', shown(mail.from)],
    ['To', shown(mail.to)],
    ...mail.cc.length > 0 ? [['Cc', shown(mail.cc)] as [string, string]] : [],
    ...mail.bcc.length > 0 ? [['Bcc', shown(mail.bcc)] as [string, string]] : [],
    ...mail.replyTo === undefined ? [] : [['Reply-To', shown(mail.replyTo)] as [string, string]],
    ['Subject', escape(mail.subject)],
    ['Sent', escape(mail.sentAt.toISOString())],
    ['Size', size],
    ...Object.entries(mail.headers).map(([name, value]) => [escape(name), escape(value)] as [string, string]),
    ...mail.attachments.map(attachment => ['Attachment', escape(`${attachment.filename} (${attachment.contentType ?? 'unknown type'}, ${typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength} bytes)`)] as [string, string]),
  ]
  const self = `${PREVIEW_PATH}/${mail.id}`
  const views = `<a href="${self}"${phone ? '' : ' aria-current="page"'}>Desktop</a><a href="${self}?view=phone"${phone ? ' aria-current="page"' : ''}>Phone</a>`
  const html = mail.html === undefined ? '' : `<h2>Html</h2><div class="bar">${views}</div><iframe${phone ? ' class="phone"' : ''} title="The mail's html" src="${self}/html"></iframe>`

  return page(mail.subject, `<div class="bar"><a href="${PREVIEW_PATH}">Outbox</a><a href="${self}/eml">Download .eml</a></div><h1>${escape(mail.subject)}</h1><table><tbody>${headers.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join('')}</tbody></table>${html}<h2>Text</h2><pre>${escape(mail.text)}</pre>`)
}

// An attachment's bytes as base64, which JSON can carry.
function jsonAttachment({ content, ...rest }: Attachment): object {
  return typeof content === 'string' ? { ...rest, content } : { ...rest, content: Buffer.from(content).toString('base64'), encoding: 'base64' }
}

// The outbox for a browser test driving the development server from another process, oldest first as `outbox.mails`, `?to=` keeping the mails to one address.
function jsonList(to: string | undefined): Response {
  const mails = to === undefined ? outbox.mails : outbox.to(to)

  return Response.json(mails.map(mail => ({ ...mail, attachments: mail.attachments.map(jsonAttachment) })), { headers: { 'cache-control': 'no-store' } })
}

// What the outbox page streams: the id of each mail sent, and a comment now and then to keep the stream open.
function events(): Response {
  const encoder = new TextEncoder()
  let stop: (() => void) | undefined
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const unwatch = outbox.watch(mail => controller.enqueue(encoder.encode(`data: ${mail.id}\n\n`)))
      const keepalive = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), KEEPALIVE_MS)

      stop = () => {
        unwatch()
        clearInterval(keepalive)
      }
    },
    cancel: () => stop?.(),
  })

  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

async function eml(mail: SentMail): Promise<Response> {
  const message = await new MailComposer(nodemailerMessage(mail)).compile().build()

  return new Response(new Uint8Array(message), { headers: { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="mail-${mail.id}.eml"`, 'cache-control': 'no-store' } })
}

const missing = (): Response => page('Not in the outbox', `<p><a href="${PREVIEW_PATH}">Outbox</a></p><p class="empty">This mail is no longer in the outbox: it keeps the last 500, and empties when the server restarts.</p>`, 404)

// The development server's view of the outbox: every mail sent since it started, newest first, each with its headers, html and text.
export const preview = new Elysia({ name: 'kayjs-mail-preview' })
  .get(PREVIEW_PATH, ({ query }) => listPage('clear' in query))
  .get(`${PREVIEW_PATH}/events`, events)
  // Only from the outbox page itself, so another site the developer visits cannot empty it.
  .post(`${PREVIEW_PATH}/clear`, ({ request }) => {
    const site = request.headers.get('sec-fetch-site')

    if (site !== null && site !== 'same-origin')
      return new Response('Refused: the outbox is cleared from its own page', { status: 403 })

    outbox.clear()

    return Response.redirect(PREVIEW_PATH, 303)
  })
  .get(`${PREVIEW_PATH}.json`, ({ query }) => jsonList(query.to))
  .get(`${PREVIEW_PATH}/:id`, ({ params, query }) => {
    const mail = outbox.find(params.id)

    return mail ? mailPage(mail, query.view === 'phone') : missing()
  })
  .get(`${PREVIEW_PATH}/:id/eml`, async ({ params }) => {
    const mail = outbox.find(params.id)

    return mail ? eml(mail) : missing()
  })
  .get(`${PREVIEW_PATH}/:id/html`, ({ params }) => {
    const html = outbox.find(params.id)?.html

    if (html === undefined)
      return missing()

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MAIL_POLICY } })
  })
