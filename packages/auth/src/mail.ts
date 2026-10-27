import type { AuthLinkKind, AuthMailData, AuthMailKind, AuthMailWording, AuthNoticeKind } from 'kay/library/auth-mails'
import type { EmailCore } from './email'
import { durationWords, escapeHtml as escape, trackDetached } from 'kay/library'
import { AUTH_LINK_KINDS, AUTH_MAIL_WORDING, AUTH_NOTICE_KINDS } from 'kay/library/auth-mails'
import { language, pickLocale } from './locale'
import { log } from './log'

// A change to what protects an account, mailed to its verified address and given to `onAuthEvent`.
export type SecurityEvent = AuthNoticeKind

// What a mail is about: a link to follow, news of a change to the account, an invitation to join an organization, or a registration for an address that has an account already.
export type MailKind = AuthMailKind

export interface MailContent {
  subject: string
  text: string
  html: string
}

// A mail for the app's mailer to send: `subject`, `text` and `html` are filled from the templates, and `kind`, `name`, `detail` and `url` let an app with its own templating ignore them.
export interface AuthMailMessage extends MailContent {
  to: string
  kind: MailKind
  // The site's name, as the templates write it.
  name: string
  // The organization an invitation is to, or the provider, passkey, token or new address an event is about.
  detail?: string
  url?: string
  // The code to type instead of following `url`, when the app sends codes.
  code?: string
  // The language it is written in, one of the `locales` option's.
  locale: string
  // How many seconds its link and its code work, for the ones it carries.
  maxAge?: { link?: number, code?: number } | undefined
}

// One address on one mailing list, as kayjs-mail's `subscriptions` answers it.
export interface MailingSubscription {
  list: string
  status: 'pending' | 'confirmed'
  askedAt: Date
  confirmedAt: Date | null
}

export interface AuthMailer {
  // Awaited, its result ignored, so a queue's enqueue fits as it is.
  send: (mail: AuthMailMessage) => unknown
  // Takes an address off the mailing lists and out of the queue when an account is erased: kayjs-mail's `mail.erase`, which `auth()` hands over when kayjs-mail is in the app.
  erase?: ((address: string) => unknown) | undefined
  // What an address is on, for the export of a user's data: kayjs-mail's `mail.subscriptions`.
  subscriptions?: ((address: string) => Promise<MailingSubscription[]>) | undefined
}

// What a template is given, the data kayjs-mail's views render from too.
export type MailData = AuthMailData

export type Templates = Record<MailKind, (data: MailData) => MailContent>

const PLACEHOLDER = /\{(\w+)\}/g

// Fills the placeholders of a mail's lines of the shared wording.
function filler(words: AuthMailWording, data: MailData): (line: string) => string {
  const values: Record<string, string> = { site: data.name, email: data.email, detail: data.detail ?? '', what: data.url === undefined ? words.code : words.link }

  return line => line.replace(PLACEHOLDER, (placeholder, name: string) => Object.hasOwn(values, name) ? values[name]! : placeholder)
}

// The two plain shells, link and notice, of kayjs-auth's own mails, for a mailer other than kayjs-mail's `authMailer`, whose views render them themed. Both parts always: a mail with text only trips spam filters, and one with HTML only is unreadable where HTML is refused. Inline styles only, since mail clients drop stylesheets.
// A link mail may carry a link, a code to type, or both.
function linkMail(words: AuthMailWording, data: MailData, subject: string, lead: string, button: string, ending: string): MailContent {
  const url = data.url === undefined ? undefined : escape(data.url)
  const codeLead = data.url === undefined ? words.yourCode : words.orTypeCode
  const text = [lead, data.url, data.code === undefined ? undefined : `${codeLead} ${data.code}`, ending].filter(part => part !== undefined).join('\n\n')

  return {
    subject,
    text,
    html: `<div lang="${escape(data.locale)}" style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;line-height:1.5;margin:0 0 20px">${escape(lead)}</p>${url === undefined
    ? ''
    : `
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px">${escape(button)}</a></p>
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0 0 12px">${escape(words.orPaste)}<br><span style="word-break:break-all">${url}</span></p>`}${data.code === undefined
    ? ''
    : `
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0 0 4px">${escape(codeLead)}</p>
  <p style="font-size:28px;letter-spacing:6px;font-family:ui-monospace,monospace;margin:0 0 20px">${escape(data.code)}</p>`}
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0">${escape(ending)}</p>
</div>`,
  }
}

// A lifetime in seconds as words in a language: `24 hours`, `7 days`, `1 heure`, from kay's `durationWords`.
export const lifetime = durationWords

// How long what the mail carries works, a magic link being usable once.
function lasting(words: AuthMailWording, data: MailData, once: boolean): string {
  const { link, code } = data.maxAge ?? {}
  const linkWorks = data.url === undefined || link === undefined ? undefined : words.linkWorks.replace('{duration}', () => lifetime(link, data.locale) + (once ? words.once : ''))
  const codeWorks = data.code === undefined || code === undefined ? undefined : words.codeWorks.replace('{duration}', () => lifetime(code, data.locale))

  return [linkWorks, codeWorks].filter(part => part !== undefined).join(' ')
}

// With a `url`, a link to where the user reviews what happened, such as the list of where they are signed in.
function noticeMail(words: AuthMailWording, data: MailData, subject: string, lead: string, ending: string): MailContent {
  return {
    subject,
    text: [lead, data.url === undefined ? undefined : `${words.review} ${data.url}`, ending].filter(part => part !== undefined).join('\n\n'),
    html: `<div lang="${escape(data.locale)}" style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;line-height:1.5;margin:0 0 20px">${escape(lead)}</p>${data.url === undefined
    ? ''
    : `
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">${escape(words.review)} <a href="${escape(data.url)}" style="color:#1a1a1a">${escape(data.url)}</a></p>`}
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0">${escape(ending)}</p>
</div>`,
  }
}

// A link mail says how long it works before its ending, unless its `lasts` is empty, as for an invitation; the figure is the one kayjs-auth sends, `lasts` itself being the fallback text of kayjs-mail's views.
function linkTemplate(words: AuthMailWording, kind: AuthLinkKind): Templates[MailKind] {
  const lines = words[kind]

  return (data) => {
    const fill = filler(words, data)
    const ending = fill(lines.ending)

    return linkMail(words, data, fill(lines.subject), fill(lines.lead), lines.button, lines.lasts === '' ? ending : `${lasting(words, data, kind === 'magic-link')} ${ending}`)
  }
}

function noticeTemplate(words: AuthMailWording, kind: AuthNoticeKind): Templates[MailKind] {
  const lines = words[kind]

  return (data) => {
    const fill = filler(words, data)

    return noticeMail(words, data, fill(lines.subject), fill(lines.lead), fill(lines.ending))
  }
}

function templatesIn(words: AuthMailWording): Templates {
  return Object.fromEntries([...AUTH_LINK_KINDS.map(kind => [kind, linkTemplate(words, kind)]), ...AUTH_NOTICE_KINDS.map(kind => [kind, noticeTemplate(words, kind)])]) as Templates
}

// kayjs-auth's own templates by language, the wording it shares with kayjs-mail, English for any other.
export const builtInTemplates: Record<string, Templates> = Object.fromEntries(Object.entries(AUTH_MAIL_WORDING).map(([lang, words]) => [lang, templatesIn(words)]))

export const defaultTemplates: Templates = builtInTemplates.en!

export const frenchTemplates: Templates = builtInTemplates.fr!

// How long a notice mail may stay with the mailer before it is given up on, and how many may be with it at once: a relay that hangs costs memory for at most this many mails, the rest being logged and dropped.
const ASIDE_TIMEOUT_MS = 30_000
const ASIDE_MAX = 200
let aside = 0
// Whether the drop in the current burst is logged already: one line says it, and the next burst, once room is back, says it again.
let dropping = false

// Sends the mail `build` makes without making the request wait on the mailer: a slow or down relay costs the response nothing, and a failure, a sync throw included, is logged. The mail is handed to the mailer before the first await, so a mailer that answers at once has it by the time this returns. A mailer silent for 30 seconds is given up on, and with 200 mails waiting on it a new one is dropped.
export function sendAside(email: EmailCore, build: () => AuthMailMessage, what: string): void {
  if (aside >= ASIDE_MAX) {
    if (!dropping)
      log.error(`mailing ${what} dropped, and the mails sent aside after it while ${ASIDE_MAX} are waiting on the mailer`)

    dropping = true

    return
  }

  dropping = false
  aside++
  trackDetached((async () => {
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(reject, ASIDE_TIMEOUT_MS, new Error(`no answer from the mailer in ${ASIDE_TIMEOUT_MS / 1000} s`))
      })

      await Promise.race([Promise.resolve(email.mailer.send(build())), timeout])
    }
    catch (error) {
      log.error(`mailing ${what} failed`, error)
    }
    finally {
      clearTimeout(timer)
      aside--
    }
  })())
}

// The language to write in for a reader wanting `wanted`, most wanted first, and its templates.
export function writing(email: EmailCore, wanted: readonly (string | null | undefined)[]): { locale: string, templates: Templates } {
  const locale = pickLocale(email.locales, wanted)

  return { locale, templates: email.templates[locale]! }
}

// Each of `locales` with kayjs-auth's templates in its language, `templates` over them and its translation over both.
export function localeTemplates(locales: readonly string[], templates: Partial<Templates> = {}, translations: Record<string, Partial<Templates>> = {}): Record<string, Templates> {
  return Object.fromEntries(locales.map(locale => [locale, { ...builtInTemplates[language(locale)] ?? defaultTemplates, ...templates, ...translations[locale] }]))
}
