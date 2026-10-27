import type { AuthKind, AuthMail } from './auth'
import { AUTH_LINK_KINDS, AUTH_MAIL_SAMPLES, AUTH_NOTICE_KINDS } from 'kay/library/auth-mails'

// A mail of `kind` as kayjs-auth hands it, for the samples page, which renders it in the site's default language: its locale, subject, text and html go unread.
export function authSample(kind: AuthKind): AuthMail {
  return { to: 'ada@example.com', kind, name: 'Example', locale: '', subject: '', text: '', html: '', ...AUTH_MAIL_SAMPLES[kind] }
}

// The samples page's names for kayjs-auth's mails, every kind of it.
export const AUTH_SAMPLES = new Map<string, AuthKind>([...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS].map(kind => [`kayjs-auth/${kind}`, kind]))
