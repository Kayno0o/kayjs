import type { EmailCore } from './email'
import type { LinkType } from './store'
import { durationWords, escapeHtml as escape, trackDetached } from 'kay/library'
import { language, pickLocale } from './locale'
import { log } from './log'

// A change to what protects an account, mailed to its verified address and given to `onAuthEvent`.
export type SecurityEvent = 'new-sign-in' | 'sign-in-locked' | 'password-changed' | 'email-changed' | 'two-factor-enabled' | 'two-factor-disabled' | 'recovery-code-used' | 'recovery-codes-regenerated' | 'provider-linked' | 'provider-unlinked' | 'passkey-added' | 'passkey-removed' | 'token-created' | 'signed-out-everywhere' | 'account-deleted' | 'organization-handed-over'

// What a mail is about: a link to follow, news of a change to the account, an invitation to join an organization, or a registration for an address that has an account already.
export type MailKind = LinkType | SecurityEvent | 'invitation' | 'account-exists'

export interface MailContent {
  subject: string
  text: string
  html: string
}

// A mail for the app's mailer to send: `subject`, `text` and `html` are filled from the templates, and `kind`, `site`, `detail` and `url` let an app with its own templating ignore them.
export interface AuthMailMessage extends MailContent {
  to: string
  kind: MailKind
  // The site's name, as the templates write it.
  site: string
  // The organization an invitation is to, or the provider, passkey, token or new address an event is about.
  detail?: string
  url?: string
  // The code to type instead of following `url`, when the app sends codes.
  code?: string
  // The language it is written in, one of the `locales` option's.
  locale: string
  // How many seconds its link and its code work, for the ones it carries.
  maxAge?: { link?: number, code?: number } | undefined
  /** @deprecated Since 1.70, dropped in 1.73: this is `maxAge`. */
  expires?: { link?: number, code?: number } | undefined
}

export interface AuthMailer {
  // Awaited, its result ignored, so a queue's enqueue fits as it is.
  send: (mail: AuthMailMessage) => unknown
}

/** @deprecated Renamed `AuthMailMessage` in 1.70, as kayjs-mail has a `Mail` of its own; the old name goes in 1.73. */
export type Mail = AuthMailMessage

/** @deprecated Renamed `AuthMailer` in 1.70, as kayjs-mail has a `Mailer` of its own; the old name goes in 1.73. */
export type Mailer = AuthMailer

// What a template is given: the site's name, the address written to, the link and the code when the mail carries them, and the provider or token an event is about, or the organization an invitation is to.
export interface MailData {
  site: string
  email: string
  url?: string | undefined
  code?: string | undefined
  detail?: string | undefined
  // The language to write in, one of the `locales` option's.
  locale: string
  // How many seconds the mail's link and its code work, for the ones it carries: `{ link: 86400, code: 600 }`. `lifetime(seconds, locale)` words them.
  maxAge?: { link?: number, code?: number } | undefined
  /** @deprecated Since 1.70, dropped in 1.73: this is `maxAge`. */
  expires?: { link?: number, code?: number } | undefined
}

export type Templates = Record<MailKind, (data: MailData) => MailContent>

// The words every mail of one language shares.
interface Wording {
  yourCode: string
  orTypeCode: string
  orPaste: string
  linkWorks: (duration: string, once: boolean) => string
  codeWorks: (duration: string) => string
  review: string
  onSite: (subject: string, site: string) => string
  notYou: string
  contactSite: string
}

const ENGLISH: Wording = {
  yourCode: 'Your code:',
  orTypeCode: 'Or type this code where you asked for it:',
  orPaste: 'Or paste this into your browser:',
  linkWorks: (duration, once) => `The link works for ${duration}${once ? ', once' : ''}.`,
  codeWorks: duration => `The code works for ${duration}, typed where you asked for it.`,
  review: 'See where your account is signed in, and end what you do not know:',
  onSite: (subject, site) => `${subject} on ${site}`,
  notYou: 'If this was not you, reset your password and check your account at once.',
  contactSite: 'If this was not you, contact the site at once.',
}

const FRENCH: Wording = {
  yourCode: 'Votre code :',
  orTypeCode: 'Ou saisissez ce code là où vous l\'avez demandé :',
  orPaste: 'Ou collez ceci dans votre navigateur :',
  linkWorks: (duration, once) => `Le lien est valable ${duration}${once ? ', une seule fois' : ''}.`,
  codeWorks: duration => `Le code est valable ${duration}, saisi là où vous l'avez demandé.`,
  review: 'Voyez où votre compte est connecté, et mettez fin à ce que vous ne reconnaissez pas :',
  onSite: (subject, site) => `${subject} sur ${site}`,
  notYou: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
  contactSite: 'Si ce n\'était pas vous, contactez le site sans attendre.',
}

// Both parts always: a mail with text only trips spam filters, and one with HTML only is unreadable where HTML is refused. Inline styles only, since mail clients drop stylesheets.
// A mail may carry a link, a code to type, or both.
function linkMail(words: Wording, data: MailData, subject: string, lead: string, button: string, ending: string): MailContent {
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
function lasting(words: Wording, data: MailData, once = false): string {
  const { link, code } = data.maxAge ?? data.expires ?? {}
  const parts = [data.url === undefined || link === undefined ? undefined : words.linkWorks(lifetime(link, data.locale), once), data.code === undefined || code === undefined ? undefined : words.codeWorks(lifetime(code, data.locale))]

  return parts.filter(part => part !== undefined).join(' ')
}

// With a `url`, a link to where the user reviews what happened, such as the list of where they are signed in.
function noticeMail(words: Wording, data: MailData, subject: string, lead: string, ending = words.notYou): MailContent {
  return {
    subject: words.onSite(subject, data.site),
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

const en = ENGLISH

export const defaultTemplates: Templates = {
  'verify-email': data => linkMail(en, data, `Confirm your email for ${data.site}`, `Confirm ${data.email} as the address of your ${data.site} account.`, 'Confirm my email', `${lasting(en, data)} If you did not create an account, ignore this mail.`),
  'reset-password': data => linkMail(en, data, `Reset your ${data.site} password`, `Someone asked to reset the password of the ${data.site} account for ${data.email}.`, 'Choose a new password', `${lasting(en, data)} If you did not ask for it, ignore this mail: your password stays as it is.`),
  'magic-link': data => linkMail(en, data, `Sign in to ${data.site}`, `Here is your ${data.url === undefined ? 'code' : 'link'} to sign in to ${data.site}.`, 'Sign in', `${lasting(en, data, true)} If you did not ask for it, ignore this mail.`),
  'change-email': data => linkMail(en, data, `Confirm your new email for ${data.site}`, `Confirm ${data.email} as the new address of your ${data.site} account.`, 'Confirm the change', `${lasting(en, data)} If you did not ask for this change, ignore this mail.`),
  'invitation': data => linkMail(en, data, `Join ${data.detail} on ${data.site}`, `You are invited to join ${data.detail} on ${data.site}, with an account at ${data.email}.`, 'See the invitation', 'If you did not expect it, ignore this mail.'),
  'account-exists': data => linkMail(en, data, `You already have a ${data.site} account`, `Someone tried to create a ${data.site} account for ${data.email}, which has one already. Sign in to it, or ask for a new password on the sign-in page if you forgot yours.`, 'Sign in', 'If this was not you, ignore this mail: nothing changed on your account.'),
  'new-sign-in': data => noticeMail(en, data, 'New sign-in', `Your ${data.site} account was just signed into from a device or network it had not used before.`),
  'sign-in-locked': data => noticeMail(en, data, 'Sign-in locked', `Too many wrong passwords or codes were tried on your ${data.site} account, so signing in to it is paused for a while.`),
  'password-changed': data => noticeMail(en, data, 'Password changed', `The password of your ${data.site} account was changed, and its other sessions signed out.`),
  'email-changed': data => noticeMail(en, data, 'Email changed', `Your ${data.site} account moved from ${data.email} to ${data.detail}. This address no longer signs into it.`, en.contactSite),
  'two-factor-enabled': data => noticeMail(en, data, 'Two-factor turned on', `Your ${data.site} account now asks for a code from your authenticator when signing in.`),
  'two-factor-disabled': data => noticeMail(en, data, 'Two-factor turned off', `Your ${data.site} account no longer asks for a code when signing in.`),
  'recovery-code-used': data => noticeMail(en, data, 'Recovery code used', `A recovery code was just used on your ${data.site} account; it will not work again.`),
  'recovery-codes-regenerated': data => noticeMail(en, data, 'New recovery codes', `Your ${data.site} account has a new set of recovery codes, and the old ones no longer work.`),
  'provider-linked': data => noticeMail(en, data, 'Account linked', `A ${data.detail} account can now sign into your ${data.site} account.`),
  'provider-unlinked': data => noticeMail(en, data, 'Account unlinked', `Your ${data.detail} account no longer signs into your ${data.site} account.`),
  'passkey-added': data => noticeMail(en, data, 'New passkey', `A passkey named ${data.detail} can now sign into your ${data.site} account.`),
  'passkey-removed': data => noticeMail(en, data, 'Passkey removed', `The passkey named ${data.detail} no longer signs into your ${data.site} account.`),
  'token-created': data => noticeMail(en, data, 'New access token', `An access token named ${data.detail} was created for your ${data.site} account.`),
  'signed-out-everywhere': data => noticeMail(en, data, 'Signed out everywhere', `Your ${data.site} account was signed out everywhere: every session and access token it had has ended.`),
  'account-deleted': data => noticeMail(en, data, 'Account deleted', `Your ${data.site} account was deleted.`, en.contactSite),
  'organization-handed-over': data => noticeMail(en, data, 'You own an organization', `You are now an owner of ${data.detail} on ${data.site}: its only owner's account was deleted.`, en.contactSite),
}

const fr = FRENCH

export const frenchTemplates: Templates = {
  'verify-email': data => linkMail(fr, data, `Confirmez votre adresse pour ${data.site}`, `Confirmez ${data.email} comme adresse de votre compte ${data.site}.`, 'Confirmer mon adresse', `${lasting(fr, data)} Si vous n'avez pas créé de compte, ignorez ce message.`),
  'reset-password': data => linkMail(fr, data, `Réinitialisez votre mot de passe ${data.site}`, `Quelqu'un a demandé à réinitialiser le mot de passe du compte ${data.site} de ${data.email}.`, 'Choisir un nouveau mot de passe', `${lasting(fr, data)} Si vous ne l'avez pas demandé, ignorez ce message : votre mot de passe reste inchangé.`),
  'magic-link': data => linkMail(fr, data, `Connexion à ${data.site}`, `Voici votre ${data.url === undefined ? 'code' : 'lien'} pour vous connecter à ${data.site}.`, 'Me connecter', `${lasting(fr, data, true)} Si vous ne l'avez pas demandé, ignorez ce message.`),
  'change-email': data => linkMail(fr, data, `Confirmez votre nouvelle adresse pour ${data.site}`, `Confirmez ${data.email} comme nouvelle adresse de votre compte ${data.site}.`, 'Confirmer le changement', `${lasting(fr, data)} Si vous n'avez pas demandé ce changement, ignorez ce message.`),
  'invitation': data => linkMail(fr, data, `Rejoignez ${data.detail} sur ${data.site}`, `Vous êtes invité à rejoindre ${data.detail} sur ${data.site}, avec un compte à l'adresse ${data.email}.`, 'Voir l\'invitation', 'Si vous ne l\'attendiez pas, ignorez ce message.'),
  'account-exists': data => linkMail(fr, data, `Vous avez déjà un compte ${data.site}`, `Quelqu'un a tenté de créer un compte ${data.site} pour ${data.email}, qui en a déjà un. Connectez-vous-y, ou demandez un nouveau mot de passe depuis la page de connexion si vous l'avez oublié.`, 'Me connecter', 'Si ce n\'était pas vous, ignorez ce message : rien n\'a changé sur votre compte.'),
  'sign-in-locked': data => noticeMail(fr, data, 'Connexion suspendue', `Trop de mots de passe ou de codes incorrects ont été essayés sur votre compte ${data.site} : la connexion est suspendue pour un moment.`),
  'new-sign-in': data => noticeMail(fr, data, 'Nouvelle connexion', `Votre compte ${data.site} vient d'être utilisé depuis un appareil ou un réseau qu'il n'avait jamais utilisé.`),
  'password-changed': data => noticeMail(fr, data, 'Mot de passe modifié', `Le mot de passe de votre compte ${data.site} a été modifié, et ses autres sessions déconnectées.`),
  'email-changed': data => noticeMail(fr, data, 'Adresse modifiée', `Votre compte ${data.site} est passé de ${data.email} à ${data.detail}. Cette adresse ne permet plus de s'y connecter.`, fr.contactSite),
  'two-factor-enabled': data => noticeMail(fr, data, 'Double authentification activée', `Votre compte ${data.site} demande désormais un code de votre application d'authentification à chaque connexion.`),
  'two-factor-disabled': data => noticeMail(fr, data, 'Double authentification désactivée', `Votre compte ${data.site} ne demande plus de code à la connexion.`),
  'recovery-code-used': data => noticeMail(fr, data, 'Code de secours utilisé', `Un code de secours vient d'être utilisé sur votre compte ${data.site} ; il ne fonctionnera plus.`),
  'recovery-codes-regenerated': data => noticeMail(fr, data, 'Nouveaux codes de secours', `Votre compte ${data.site} a de nouveaux codes de secours, et les anciens ne fonctionnent plus.`),
  'provider-linked': data => noticeMail(fr, data, 'Compte associé', `Un compte ${data.detail} peut désormais se connecter à votre compte ${data.site}.`),
  'provider-unlinked': data => noticeMail(fr, data, 'Compte dissocié', `Votre compte ${data.detail} ne permet plus de se connecter à votre compte ${data.site}.`),
  'passkey-added': data => noticeMail(fr, data, 'Nouvelle clé d\'accès', `Une clé d'accès nommée ${data.detail} peut désormais se connecter à votre compte ${data.site}.`),
  'passkey-removed': data => noticeMail(fr, data, 'Clé d\'accès supprimée', `La clé d'accès nommée ${data.detail} ne permet plus de se connecter à votre compte ${data.site}.`),
  'token-created': data => noticeMail(fr, data, 'Nouveau jeton d\'accès', `Un jeton d'accès nommé ${data.detail} a été créé pour votre compte ${data.site}.`),
  'signed-out-everywhere': data => noticeMail(fr, data, 'Déconnexion partout', `Votre compte ${data.site} a été déconnecté partout : toutes ses sessions et tous ses jetons d'accès ont pris fin.`),
  'account-deleted': data => noticeMail(fr, data, 'Compte supprimé', `Votre compte ${data.site} a été supprimé.`, fr.contactSite),
  'organization-handed-over': data => noticeMail(fr, data, 'Vous dirigez une organisation', `Vous êtes désormais propriétaire de ${data.detail} sur ${data.site} : le compte de son seul propriétaire a été supprimé.`, fr.contactSite),
}

// kayjs-auth's own templates by language, English for any other.
export const builtInTemplates: Record<string, Templates> = { en: defaultTemplates, fr: frenchTemplates }

// How long a notice mail may stay with the mailer before it is given up on, and how many may be with it at once: a relay that hangs costs memory for at most this many mails, the rest being logged and dropped.
const ASIDE_TIMEOUT_MS = 30_000
const ASIDE_MAX = 200
let aside = 0
// Whether the drop in the current burst is logged already: one line says it, and the next burst, once room is back, says it again.
let dropping = false

// Sends the mail `build` makes without making the request wait on the mailer: a slow or down relay costs the response nothing, and a failure, a sync throw included, is logged. The mail is handed to the mailer before the first await, so a mailer that answers at once has it by the time this returns. A mailer silent for 30 seconds is given up on, and with 200 mails waiting on it a new one is dropped.
export function sendAside(email: EmailCore, build: () => Mail, what: string): void {
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
