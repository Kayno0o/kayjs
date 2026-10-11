import type { JSX } from 'kay'
import type { Message } from './types'
import { renderToString } from 'kay/server'
import { decode } from './text'

// kayjs-auth's kinds of mail: a link to follow or a code to type, then news of a change to the account.
export type AuthLinkKind = 'verify-email' | 'reset-password' | 'magic-link' | 'change-email' | 'invitation'
export type AuthNoticeKind = 'new-sign-in' | 'password-changed' | 'email-changed' | 'two-factor-enabled' | 'two-factor-disabled' | 'recovery-code-used' | 'recovery-codes-regenerated' | 'provider-linked' | 'provider-unlinked' | 'passkey-added' | 'passkey-removed' | 'token-created' | 'account-deleted'
export type AuthKind = AuthLinkKind | AuthNoticeKind

export const AUTH_LINK_KINDS: readonly AuthLinkKind[] = ['verify-email', 'reset-password', 'magic-link', 'change-email', 'invitation']
export const AUTH_NOTICE_KINDS: readonly AuthNoticeKind[] = ['new-sign-in', 'password-changed', 'email-changed', 'two-factor-enabled', 'two-factor-disabled', 'recovery-code-used', 'recovery-codes-regenerated', 'provider-linked', 'provider-unlinked', 'passkey-added', 'passkey-removed', 'token-created', 'account-deleted']

export const LINK_KINDS = new Set<string>(AUTH_LINK_KINDS)
const NOTICE_KINDS = new Set<string>(AUTH_NOTICE_KINDS)

// A mail kayjs-auth hands its mailer, typed by its shape so neither package depends on the other.
export interface AuthMail {
  to: string
  kind: string
  // The site's name.
  site: string
  locale: string
  subject: string
  text: string
  html: string
  url?: string | undefined
  code?: string | undefined
  // The organization an invitation is to, or the provider, passkey, token or new address an event is about.
  detail?: string | undefined
}

export type AuthView = (props: { mail: AuthMail }) => JSX.Element

export interface AuthMailerOptions {
  // An app's own view for any kind, imported once its first mail goes: `{ 'reset-password': () => import('./mails/auth/reset-password.kay') }`.
  views?: Partial<Record<AuthKind, () => Promise<{ default: AuthView }>>> | undefined
}

// A mailer's `send`, `enqueue` or `render`.
type Send<R> = <P extends object>(message: Message<P>) => R | Promise<R>

// Set once an app hands kayjs-auth a mailer of this, so the samples page lists kayjs-auth's mails, through the app's own views.
let authOptions: AuthMailerOptions | undefined

export function authMailerOptions(): AuthMailerOptions | undefined {
  return authOptions
}

// kayjs-auth's `email.mailer`, rendering each mail through the app's view for its kind or the shipped one, in kayjs-mail's wording the app's messages override, themed by the app's mail settings and in the mail's language, and handing it to `send`, a mailer's `send` or `enqueue`.
export function authMailer<R>(send: Send<R>, options: AuthMailerOptions = {}): { send: (mail: AuthMail) => Promise<R> } {
  authOptions = options

  return { send: async mail => await send(await authMessage(mail, options, mail.locale)) }
}

// The message `authMailer` sends for a mail, rendered in `lang`, the site's default language when undefined. A kind it does not know goes as kayjs-auth wrote it.
export async function authMessage(mail: AuthMail, options: AuthMailerOptions, lang: string | undefined): Promise<Message<{ mail: AuthMail }>> {
  if (!LINK_KINDS.has(mail.kind) && !NOTICE_KINDS.has(mail.kind))
    return { to: mail.to, subject: mail.subject, lang, html: mail.html, text: mail.text }

  const own = options.views?.[mail.kind as AuthKind]
  // Imported here, as the module loads with kay.config.ts before kay compiles any .kay file; typed by hand, as kay check types a package's .kay files for the apps importing them alone.
  const view = own === undefined ? (await (LINK_KINDS.has(mail.kind) ? import('./auth-link.kay' as string) : import('./auth-notice.kay' as string)) as { default: AuthView }).default : (await own()).default
  const subject = (await import('./auth-subject.kay' as string) as { default: AuthView }).default
  // The subject goes through the messages as the view does, in the same language.
  const written = await renderToString(subject, { mail }, { locale: lang })

  return { to: mail.to, subject: decode(written), lang, view, props: { mail } }
}
