import type { JSX } from 'kay'
import type { Message } from './types'

// kayjs-auth's wording for a link to follow or a code to type, its `MailParts` of type `link`.
export interface AuthLinkParts {
  type: 'link'
  lead: string
  button: string
  orPaste: string
  codeLead: string
  ending: string
}

// kayjs-auth's wording for news of a change to the account, its `MailParts` of type `notice`.
export interface AuthNoticeParts {
  type: 'notice'
  lead: string
  review: string
  ending: string
}

// A mail kayjs-auth hands its mailer, typed by its shape so neither package depends on the other.
export interface AuthMail {
  to: string
  kind: string
  locale: string
  subject: string
  text: string
  html: string
  url?: string | undefined
  code?: string | undefined
  // Left out by an app's own kayjs-auth templates, whose html is then sent as it is.
  parts?: AuthLinkParts | AuthNoticeParts | undefined
}

export type AuthView = (props: { mail: AuthMail }) => JSX.Element

type LinkView = (props: { mail: AuthMail, parts: AuthLinkParts }) => JSX.Element
type NoticeView = (props: { mail: AuthMail, parts: AuthNoticeParts }) => JSX.Element

export interface AuthMailerOptions {
  // An app's own view for any kind, `reset-password` say, in place of the shipped one.
  views?: Partial<Record<string, AuthView>> | undefined
}

// A mailer's `send`, `enqueue` or `render`.
type Send<R> = <P extends object>(message: Message<P>) => R | Promise<R>

// Set once an app hands kayjs-auth a mailer of this, so the samples page lists the views it renders.
let rendersAuth = false

export function rendersAuthMails(): boolean {
  return rendersAuth
}

// kayjs-auth's `email.mailer`, rendering each mail through the shipped components, themed by the app's mail settings and in the mail's language, and handing it to `send`, a mailer's `send` or `enqueue`.
export function authMailer<R>(send: Send<R>, options: AuthMailerOptions = {}): { send: (mail: AuthMail) => Promise<R> } {
  rendersAuth = true

  return authSender(send, options)
}

// `authMailer` without listing its views on the samples page, which renders them through it.
export function authSender<R>(send: Send<R>, options: AuthMailerOptions = {}): { send: (mail: AuthMail) => Promise<R> } {
  return {
    send: async (mail) => {
      const envelope = { to: mail.to, subject: mail.subject, lang: mail.locale }
      const own = options.views?.[mail.kind]

      if (own !== undefined)
        return await send({ ...envelope, view: own, props: { mail } })

      // Imported here rather than at the top, as the module loads with kay.config.ts, before kay compiles any .kay file; typed by hand, as kay check types a package's .kay files for the apps importing them alone.
      if (mail.parts?.type === 'link') {
        const view = (await import('./auth-link.kay' as string) as { default: LinkView }).default

        return await send({ ...envelope, view, props: { mail, parts: mail.parts }, text: mail.text })
      }

      if (mail.parts?.type === 'notice') {
        const view = (await import('./auth-notice.kay' as string) as { default: NoticeView }).default

        return await send({ ...envelope, view, props: { mail, parts: mail.parts }, text: mail.text })
      }

      return await send({ ...envelope, html: mail.html, text: mail.text })
    },
  }
}
