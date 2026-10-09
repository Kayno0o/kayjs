import type { TokenType } from './store'

// A change to what protects an account, mailed to its verified address and given to `onEvent`.
export type SecurityEvent = 'new-sign-in' | 'password-changed' | 'email-changed' | 'two-factor-enabled' | 'two-factor-disabled' | 'recovery-code-used' | 'recovery-codes-regenerated' | 'provider-linked' | 'provider-unlinked' | 'token-created' | 'account-deleted'

// What a mail is about: a link to follow, or news of a change to the account.
export type MailKind = TokenType | SecurityEvent

export interface MailContent {
  subject: string
  text: string
  html: string
}

// A mail for the app's mailer to send: `subject`, `text` and `html` are filled from the templates, and `kind` and `url` let an app with its own templating ignore them.
export interface Mail extends MailContent {
  to: string
  kind: MailKind
  url?: string
}

export interface Mailer {
  // Awaited, its result ignored, so a queue's enqueue fits as it is.
  send: (mail: Mail) => unknown
}

// What a template is given: the site's name, the address written to, the link when the mail carries one, and the provider or token an event is about.
export interface MailData {
  site: string
  email: string
  url?: string | undefined
  detail?: string | undefined
}

export type Templates = Record<MailKind, (data: MailData) => MailContent>

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const HTML_SPECIAL = /[&<>"']/g

function escape(text: string): string {
  return text.replace(HTML_SPECIAL, char => HTML_ESCAPES[char]!)
}

// Both parts always: a mail with text only trips spam filters, and one with HTML only is unreadable where HTML is refused. Inline styles only, since mail clients drop stylesheets.
function linkMail(data: MailData, subject: string, lead: string, button: string, ending: string): MailContent {
  const url = escape(data.url ?? '')

  return {
    subject,
    text: `${lead}\n\n${data.url}\n\n${ending}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;line-height:1.5;margin:0 0 20px">${escape(lead)}</p>
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px">${escape(button)}</a></p>
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0 0 12px">Or paste this into your browser:<br><span style="word-break:break-all">${url}</span></p>
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0">${escape(ending)}</p>
</div>`,
  }
}

const NOT_YOU = 'If this was not you, reset your password and check your account at once.'

function noticeMail(data: MailData, subject: string, lead: string, ending = NOT_YOU): MailContent {
  return {
    subject: `${subject} on ${data.site}`,
    text: `${lead}\n\n${ending}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;line-height:1.5;margin:0 0 20px">${escape(lead)}</p>
  <p style="font-size:13px;line-height:1.5;color:#555555;margin:0">${escape(ending)}</p>
</div>`,
  }
}

export const defaultTemplates: Templates = {
  'verify-email': data => linkMail(data, `Confirm your email for ${data.site}`, `Confirm ${data.email} as the address of your ${data.site} account.`, 'Confirm my email', 'The link works for 24 hours. If you did not create an account, ignore this mail.'),
  'reset-password': data => linkMail(data, `Reset your ${data.site} password`, `Someone asked to reset the password of the ${data.site} account for ${data.email}.`, 'Choose a new password', 'The link works for one hour. If you did not ask for it, ignore this mail: your password stays as it is.'),
  'magic-link': data => linkMail(data, `Sign in to ${data.site}`, `Here is your link to sign in to ${data.site}.`, 'Sign in', 'The link works for 15 minutes, once. If you did not ask for it, ignore this mail.'),
  'change-email': data => linkMail(data, `Confirm your new email for ${data.site}`, `Confirm ${data.email} as the new address of your ${data.site} account.`, 'Confirm the change', 'The link works for one hour. If you did not ask for this change, ignore this mail.'),
  'new-sign-in': data => noticeMail(data, 'New sign-in', `Your ${data.site} account was just signed into from a device or network it had not used before.`),
  'password-changed': data => noticeMail(data, 'Password changed', `The password of your ${data.site} account was changed, and its other sessions signed out.`),
  'email-changed': data => noticeMail(data, 'Email changed', `Your ${data.site} account moved from ${data.email} to ${data.detail}. This address no longer signs into it.`, 'If this was not you, contact the site at once.'),
  'two-factor-enabled': data => noticeMail(data, 'Two-factor turned on', `Your ${data.site} account now asks for a code from your authenticator when signing in.`),
  'two-factor-disabled': data => noticeMail(data, 'Two-factor turned off', `Your ${data.site} account no longer asks for a code when signing in.`),
  'recovery-code-used': data => noticeMail(data, 'Recovery code used', `A recovery code was just used on your ${data.site} account; it will not work again.`),
  'recovery-codes-regenerated': data => noticeMail(data, 'New recovery codes', `Your ${data.site} account has a new set of recovery codes, and the old ones no longer work.`),
  'provider-linked': data => noticeMail(data, 'Account linked', `A ${data.detail} account can now sign into your ${data.site} account.`),
  'provider-unlinked': data => noticeMail(data, 'Account unlinked', `Your ${data.detail} account no longer signs into your ${data.site} account.`),
  'token-created': data => noticeMail(data, 'New access token', `An access token named ${data.detail} was created for your ${data.site} account.`),
  'account-deleted': data => noticeMail(data, 'Account deleted', `Your ${data.site} account was deleted.`, 'If this was not you, contact the site at once.'),
}
