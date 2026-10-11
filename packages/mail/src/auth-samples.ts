import type { AuthMail } from './auth'

const SITE = 'Example'
const EMAIL = 'ada@example.com'
const URL = 'https://example.com/verify?token=sample'

// The text kayjs-auth writes beside its html.
function withText(mail: Omit<AuthMail, 'text'>): AuthMail {
  const { parts, url, code } = mail
  const lines = parts?.type === 'notice' ? [parts.lead, url === undefined ? undefined : `${parts.review} ${url}`, parts.ending] : [parts?.lead, url, code === undefined ? undefined : `${parts?.codeLead} ${code}`, parts?.ending]

  return { ...mail, text: lines.filter(line => line !== undefined).join('\n\n') }
}

// One mail of each shape `authMailer` renders, in kayjs-auth's English wording, which the samples page shows once an app uses it.
export const AUTH_SAMPLES: Record<string, AuthMail> = {
  'kayjs-auth/verify-email': withText({
    to: EMAIL,
    kind: 'verify-email',
    locale: 'en',
    subject: `Confirm your email for ${SITE}`,
    html: '',
    url: URL,
    code: '482913',
    parts: { type: 'link', lead: `Confirm ${EMAIL} as the address of your ${SITE} account.`, button: 'Confirm my email', orPaste: 'Or paste this into your browser:', codeLead: 'Or type this code where you asked for it:', ending: 'The link works for 24 hours. The code works for 10 minutes, typed where you asked for it. If you did not create an account, ignore this mail.' },
  }),
  'kayjs-auth/magic-link': withText({
    to: EMAIL,
    kind: 'magic-link',
    locale: 'en',
    subject: `Sign in to ${SITE}`,
    html: '',
    code: '482913',
    parts: { type: 'link', lead: `Here is your code to sign in to ${SITE}.`, button: 'Sign in', orPaste: 'Or paste this into your browser:', codeLead: 'Your code:', ending: 'The code works for 10 minutes, typed where you asked for it. If you did not ask for it, ignore this mail.' },
  }),
  'kayjs-auth/invitation': withText({
    to: EMAIL,
    kind: 'invitation',
    locale: 'en',
    subject: `Join Acme on ${SITE}`,
    html: '',
    url: 'https://example.com/invitation?invitation=sample',
    parts: { type: 'link', lead: `You are invited to join Acme on ${SITE}, with an account at ${EMAIL}.`, button: 'See the invitation', orPaste: 'Or paste this into your browser:', codeLead: 'Your code:', ending: 'If you did not expect it, ignore this mail.' },
  }),
  'kayjs-auth/new-sign-in': withText({
    to: EMAIL,
    kind: 'new-sign-in',
    locale: 'en',
    subject: `New sign-in on ${SITE}`,
    html: '',
    url: 'https://example.com/account/sessions',
    parts: { type: 'notice', lead: `Your ${SITE} account was just signed into from a device or network it had not used before.`, review: 'See where your account is signed in, and end what you do not know:', ending: 'If this was not you, reset your password and check your account at once.' },
  }),
}
