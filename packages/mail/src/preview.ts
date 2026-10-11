import type { SentMail } from './outbox'
import type { Address, Attachment, Delivery, Mail, Message } from './types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import MailComposer from 'nodemailer/lib/mail-composer'
import { authMailerOptions, authSender } from './auth'
import { AUTH_SAMPLES } from './auth-samples'
import { escapeHtml as escape } from './escape'
import { outbox } from './outbox'
import { nodemailerMessage } from './smtp'

export const PREVIEW_PATH = '/_kay/mail'

// The mail's own markup runs nothing and loads only images and fonts, so a link or a script in it never acts as the development site.
const MAIL_POLICY = 'sandbox allow-popups allow-popups-to-escape-sandbox; default-src \'none\'; img-src * data: cid:; style-src \'unsafe-inline\' *; font-src * data:'

export const SAMPLES_PATH = `${PREVIEW_PATH}/samples`
// Where an app keeps its mails, from its root, which `kay dev` runs the server in.
const MAILS_DIR = 'src/mails'
const KAY_FILE = new Bun.Glob('**/*.kay')
const KAY_EXTENSION = /\.kay$/
const SAMPLE_ADDRESS = 'sample@localhost'
// One address, as the send form takes: a comma or a name would add a recipient.
const ONE_ADDRESS = /^[^\s<>@,]+@[^\s<>@,]+$/

// The environment's SMTP as the development pages send over it, read when first asked.
export interface Relay {
  // The variables it lacks to send, empty once it can.
  missing: () => string[]
  // Its host and port, as the pages name it.
  server: () => string
  // `MAIL_TO`, which the form offers.
  to: () => string | undefined
  send: (mail: Mail, to: string) => Promise<Delivery>
}

// How the last send from a page went: sent when `error` is absent.
interface Outcome {
  to: string
  error?: string | undefined
}

// Reloads the list as each mail arrives.
const LIVE = `new EventSource('${PREVIEW_PATH}/events').onmessage=()=>location.reload()`
// Reloads a sample once `kay dev` restarts the server for a changed file: its stream names the server it comes from first.
const RESTARTED = `let b;new EventSource('/_kay/dev/events').addEventListener('boot',e=>{const i=e.data.split(' ')[0];if(b&&i!==b)location.reload();b=i})`

const hashOf = (script: string): string => `'sha256-${createHash('sha256').update(script).digest('base64')}'`

// The pages' own policy, which a site's narrower one, such as a `frame-src` naming only a map provider, would otherwise replace and leave the mail's frame blank.
const PAGE_POLICY = `default-src 'none'; style-src 'unsafe-inline'; script-src ${hashOf(LIVE)} ${hashOf(RESTARTED)}; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'`

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
.sent{color:#166534;font-weight:600}
input{font:inherit;padding:5px 8px;min-width:16em}
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
    return page('Outbox', `<h1>Outbox</h1><div class="bar"><a href="${SAMPLES_PATH}">Mail samples</a></div><p class="empty">No mail sent since the server started. Mails show here as they are sent.</p>`, 200, live)

  const count = `${mails.length} mail${mails.length === 1 ? '' : 's'}`
  const bar = clearing
    ? `<form class="confirm" method="post" action="${PREVIEW_PATH}/clear"><p>Clear the ${count} in the outbox? Their pages go with them.</p><div class="bar"><button type="submit">Clear ${count}</button><a href="${PREVIEW_PATH}">Cancel</a></div></form>`
    : `<div class="bar"><span>${count}, newest first</span><a href="${PREVIEW_PATH}?clear">Clear the outbox</a><a href="${SAMPLES_PATH}">Mail samples</a></div>`
  const rows = mails.map(mail => `<tr><td>${escape(mail.sentAt.toLocaleTimeString('en-GB'))}</td><td>${shown(mail.to)}</td><td><a href="${PREVIEW_PATH}/${mail.id}">${escape(mail.subject)}</a></td></tr>`)

  return page('Outbox', `<h1>Outbox</h1>${bar}<table><thead><tr><th>Sent</th><th>To</th><th>Subject</th></tr></thead><tbody>${rows.join('')}</tbody></table>`, 200, live)
}

function sizeOf(mail: Mail): string {
  const htmlBytes = mail.html === undefined ? 0 : Buffer.byteLength(mail.html)
  const clipped = htmlBytes > GMAIL_CLIP_BYTES ? ` <span class="warning">Gmail clips it: its html passes ${kilobytes(GMAIL_CLIP_BYTES)}</span>` : ''

  return `${kilobytes(htmlBytes + Buffer.byteLength(mail.text))}, html ${kilobytes(htmlBytes)}${clipped}`
}

// The mail's html in a frame at desktop or phone width, as `view` links to each, then its text.
function rendered(mail: Mail, view: (phone: boolean) => string, frame: string, phone: boolean): string {
  const views = `<a href="${view(false)}"${phone ? '' : ' aria-current="page"'}>Desktop</a><a href="${view(true)}"${phone ? ' aria-current="page"' : ''}>Phone</a>`
  const html = mail.html === undefined ? '' : `<h2>Html</h2><div class="bar">${views}</div><iframe${phone ? ' class="phone"' : ''} title="The mail's html" src="${frame}"></iframe>`

  return `${html}<h2>Text</h2><pre>${escape(mail.text)}</pre>`
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// The form sending the mail for real over the environment's SMTP, with how the last send went, or what the environment lacks for it.
function sendForm(relay: Relay, action: string, outcome: Outcome | undefined): string {
  let missing: string[]

  try {
    missing = relay.missing()
  }
  catch (error) {
    return `<h2>Send for real</h2><p class="warning">${escape(messageOf(error))}</p>`
  }

  if (missing.length > 0)
    return `<h2>Send for real</h2><p>Set ${missing.join(' and ')} to send this mail over SMTP, a relay's or a local mailpit's.</p>`

  const server = escape(relay.server())
  const offered = outcome?.to ?? relay.to() ?? ''
  const result = outcome === undefined ? '' : outcome.error === undefined ? `<p class="sent">Sent to ${escape(outcome.to)} over ${server}.</p>` : `<p class="warning">Not sent: ${escape(outcome.error)}</p>`

  return `<h2>Send for real</h2>${result}<form class="bar" method="post" action="${action}"><label>Over ${server} to <input type="email" name="to" required value="${escape(ONE_ADDRESS.test(offered) ? offered : '')}"></label><button type="submit">Send</button></form>`
}

// Sends it over the relay, answering what went wrong, or nothing once the server took it.
async function attempt(relay: Relay, mail: Mail, to: string): Promise<string | undefined> {
  try {
    const { rejected, response } = await relay.send(mail, to)

    return rejected.length > 0 ? `the server refused ${rejected.join(', ')}${response ? `: ${response}` : ''}` : undefined
  }
  catch (error) {
    return messageOf(error)
  }
}

// The address a send form posted, when it is one.
function postedAddress(body: unknown): string | undefined {
  const to = typeof body === 'object' && body !== null && 'to' in body && typeof body.to === 'string' ? body.to.trim() : undefined

  return to !== undefined && ONE_ADDRESS.test(to) ? to : undefined
}

// Only from the development pages themselves, so another site the developer visits cannot act through them.
function crossSite(request: Request, refusal: string): Response | undefined {
  const site = request.headers.get('sec-fetch-site')

  return site !== null && site !== 'same-origin' ? new Response(`Refused: ${refusal}`, { status: 403 }) : undefined
}

function mailPage(mail: SentMail, phone: boolean, relay: Relay, outcome?: Outcome, status = 200): Response {
  const headers: [string, string][] = [
    ['From', shown(mail.from)],
    ['To', shown(mail.to)],
    ...mail.cc.length > 0 ? [['Cc', shown(mail.cc)] as [string, string]] : [],
    ...mail.bcc.length > 0 ? [['Bcc', shown(mail.bcc)] as [string, string]] : [],
    ...mail.replyTo === undefined ? [] : [['Reply-To', shown(mail.replyTo)] as [string, string]],
    ['Subject', escape(mail.subject)],
    ['Sent', escape(mail.sentAt.toISOString())],
    ['Size', sizeOf(mail)],
    ...Object.entries(mail.headers).map(([name, value]) => [escape(name), escape(value)] as [string, string]),
    ...mail.attachments.map(attachment => ['Attachment', escape(`${attachment.filename} (${attachment.contentType ?? 'unknown type'}, ${typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength} bytes)`)] as [string, string]),
  ]
  const self = `${PREVIEW_PATH}/${mail.id}`

  return page(mail.subject, `<div class="bar"><a href="${PREVIEW_PATH}">Outbox</a><a href="${self}/eml">Download .eml</a></div><h1>${escape(mail.subject)}</h1><table><tbody>${headers.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join('')}</tbody></table>${sendForm(relay, `${self}/send`, outcome)}${rendered(mail, phone => phone ? `${self}?view=phone` : self, `${self}/html`, phone)}`, status)
}

// The app's mails, as paths from its mails folder, then kayjs-auth's once `authMailer` renders them.
async function mailFiles(): Promise<string[]> {
  const own = (await Array.fromAsync(KAY_FILE.scan({ cwd: join(process.cwd(), MAILS_DIR), onlyFiles: true }))).toSorted()

  return authMailerOptions() ? [...own, ...Object.keys(AUTH_SAMPLES)] : own
}

const previewOf = (file: string): string => file.replace(KAY_EXTENSION, '.preview.ts')

// A mail rendered as the mailer renders it, with the props its `<name>.preview.ts` default-exports, or none, and whether it had them.
async function sample(file: string, render: (message: Message) => Promise<Mail>): Promise<{ mail: Mail, sampled: boolean }> {
  const auth = AUTH_SAMPLES[file]

  // In the site's default language, which the English sample may not be one of.
  if (auth !== undefined)
    return { mail: await authSender(async message => render({ ...message, lang: undefined } as Message), authMailerOptions()).send(auth), sampled: true }

  const props = join(process.cwd(), MAILS_DIR, previewOf(file))
  const view = (await import(join(process.cwd(), MAILS_DIR, file))).default
  const sampled = await Bun.file(props).exists()
  const mail = await render({ to: SAMPLE_ADDRESS, subject: file, view, props: sampled ? (await import(props)).default : undefined })

  return { mail, sampled }
}

function samplesPage(files: string[]): Response {
  const live = `<script>${RESTARTED}</script>`
  const back = `<div class="bar"><a href="${PREVIEW_PATH}">Outbox</a></div>`

  if (files.length === 0)
    return page('Mail samples', `${back}<h1>Mail samples</h1><p class="empty">No .kay mail under ${MAILS_DIR}.</p>`, 200, live)

  const rows = files.map(file => `<li><a href="${SAMPLES_PATH}?mail=${encodeURIComponent(file)}">${escape(file)}</a></li>`)

  return page('Mail samples', `${back}<h1>Mail samples</h1><p>Each mail under ${MAILS_DIR}, rendered with the props its <code>&lt;name&gt;.preview.ts</code> default-exports.</p><ul>${rows.join('')}</ul>`, 200, live)
}

async function samplePage(file: string, phone: boolean, render: (message: Message) => Promise<Mail>, relay: Relay, outcome?: Outcome, status = 200): Promise<Response> {
  const live = `<script>${RESTARTED}</script>`
  const self = `${SAMPLES_PATH}?mail=${encodeURIComponent(file)}`
  const back = `<div class="bar"><a href="${SAMPLES_PATH}">Mail samples</a></div>`

  try {
    const { mail, sampled } = await sample(file, render)
    const props = file in AUTH_SAMPLES ? 'a sample of kayjs-auth\'s, through authMailer' : sampled ? escape(previewOf(file)) : `none, as there is no ${escape(previewOf(file))}`

    return page(file, `${back}<h1>${escape(file)}</h1><table><tbody><tr><th>Props</th><td>${props}</td></tr><tr><th>Size</th><td>${sizeOf(mail)}</td></tr></tbody></table>${sendForm(relay, `${SAMPLES_PATH}/send?mail=${encodeURIComponent(file)}`, outcome)}${rendered(mail, phone => phone ? `${self}&amp;view=phone` : self, `${SAMPLES_PATH}/html?mail=${encodeURIComponent(file)}`, phone)}`, status, live)
  }
  catch (error) {
    return page(file, `${back}<h1>${escape(file)}</h1><p class="warning">It did not render: ${escape(error instanceof Error ? error.message : String(error))}</p><p>A mail taking props renders with those ${escape(previewOf(file))} default-exports beside it.</p>`, 500, live)
  }
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

const notSample = (): Response => page('No such mail', `<p><a href="${SAMPLES_PATH}">Mail samples</a></p><p class="empty">No .kay mail by this name under ${MAILS_DIR}.</p>`, 404)

// What the mail frame shows: markup that runs nothing and acts as no page of the site.
function mailHtml(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': MAIL_POLICY } })
}

const sentTo = (to: string | undefined): Outcome | undefined => to === undefined ? undefined : { to }

// The development server's view of the outbox, every mail sent since it started, newest first, each with its headers, html and text, and of the app's mails rendered with sample props, through `render`.
export function preview(render: (message: Message) => Promise<Mail>, relay: Relay) {
  return new Elysia({ name: 'kayjs-mail-preview' })
    .get(PREVIEW_PATH, ({ query }) => listPage('clear' in query))
    .get(SAMPLES_PATH, async ({ query }) => {
      const files = await mailFiles()

      if (query.mail === undefined)
        return samplesPage(files)

      return files.includes(query.mail) ? samplePage(query.mail, query.view === 'phone', render, relay, sentTo(query.sent)) : notSample()
    })
    .post(`${SAMPLES_PATH}/send`, async ({ query, request, body }) => {
      const refused = crossSite(request, 'a sample is sent from its own page')

      if (refused)
        return refused

      if (query.mail === undefined || !(await mailFiles()).includes(query.mail))
        return notSample()

      const to = postedAddress(body)

      if (to === undefined)
        return samplePage(query.mail, false, render, relay, { to: '', error: 'type one address to send it to' }, 400)

      const error = await attempt(relay, (await sample(query.mail, render)).mail, to)

      return error === undefined ? Response.redirect(`${SAMPLES_PATH}?mail=${encodeURIComponent(query.mail)}&sent=${encodeURIComponent(to)}`, 303) : samplePage(query.mail, false, render, relay, { to, error }, 502)
    })
    .get(`${SAMPLES_PATH}/html`, async ({ query }) => {
      if (query.mail === undefined || !(await mailFiles()).includes(query.mail))
        return notSample()

      const { html } = (await sample(query.mail, render)).mail

      return html === undefined ? notSample() : mailHtml(html)
    })
    .get(`${PREVIEW_PATH}/events`, events)
    .post(`${PREVIEW_PATH}/clear`, ({ request }) => {
      const refused = crossSite(request, 'the outbox is cleared from its own page')

      if (refused)
        return refused

      outbox.clear()

      return Response.redirect(PREVIEW_PATH, 303)
    })
    .get(`${PREVIEW_PATH}.json`, ({ query }) => jsonList(query.to))
    .get(`${PREVIEW_PATH}/:id`, ({ params, query }) => {
      const mail = outbox.find(params.id)

      return mail ? mailPage(mail, query.view === 'phone', relay, sentTo(query.sent)) : missing()
    })
    .post(`${PREVIEW_PATH}/:id/send`, async ({ params, request, body }) => {
      const refused = crossSite(request, 'a mail is sent from its own page')

      if (refused)
        return refused

      const mail = outbox.find(params.id)

      if (!mail)
        return missing()

      const to = postedAddress(body)

      if (to === undefined)
        return mailPage(mail, false, relay, { to: '', error: 'type one address to send it to' }, 400)

      const error = await attempt(relay, mail, to)

      return error === undefined ? Response.redirect(`${PREVIEW_PATH}/${mail.id}?sent=${encodeURIComponent(to)}`, 303) : mailPage(mail, false, relay, { to, error }, 502)
    })
    .get(`${PREVIEW_PATH}/:id/eml`, async ({ params }) => {
      const mail = outbox.find(params.id)

      return mail ? eml(mail) : missing()
    })
    .get(`${PREVIEW_PATH}/:id/html`, ({ params }) => {
      const html = outbox.find(params.id)?.html

      if (html === undefined)
        return missing()

      return mailHtml(html)
    })
}
