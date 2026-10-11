import type { AuthKind, AuthMail } from './auth'
import { AUTH_LINK_KINDS, AUTH_NOTICE_KINDS } from './auth'

const LINK = 'https://example.com/auth?token=sample'
const CODE = '482913'

// What a sample of each kind carries beyond the site and the address, as kayjs-auth fills it.
const CARRIES: Partial<Record<AuthKind, Partial<AuthMail>>> = {
  'verify-email': { url: LINK, code: CODE },
  'reset-password': { url: LINK },
  'magic-link': { url: LINK, code: CODE },
  'change-email': { url: LINK },
  'invitation': { url: 'https://example.com/invitation?invitation=sample', detail: 'Acme' },
  'new-sign-in': { url: 'https://example.com/account/sessions' },
  'email-changed': { detail: 'ada@example.org' },
  'provider-linked': { detail: 'GitHub' },
  'provider-unlinked': { detail: 'GitHub' },
  'passkey-added': { detail: 'Laptop' },
  'passkey-removed': { detail: 'Laptop' },
  'token-created': { detail: 'Deploys' },
}

// A mail of `kind` as kayjs-auth hands it, for the samples page, which renders it in the site's default language: its locale, subject, text and html go unread.
export function authSample(kind: AuthKind): AuthMail {
  return { to: 'ada@example.com', kind, site: 'Example', locale: '', subject: '', text: '', html: '', ...CARRIES[kind] }
}

// The samples page's names for kayjs-auth's mails, every kind of it.
export const AUTH_SAMPLES = new Map<string, AuthKind>([...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS].map(kind => [`kayjs-auth/${kind}`, kind]))
