// kayjs-auth's mails, which kayjs-auth sends and kayjs-mail renders: their kinds, what each carries and their wording in each language shipped, read by both so neither depends on the other. Not API, like `kay/library`; it imports nothing, as kayjs-mail's French catalog imports it and `kay check` imports catalogs.

// A link to follow or a code to type, then news of a change to the account.
export const AUTH_LINK_KINDS = ['verify-email', 'reset-password', 'magic-link', 'change-email', 'invitation', 'account-exists'] as const
export const AUTH_NOTICE_KINDS = ['new-sign-in', 'sign-in-locked', 'password-changed', 'email-changed', 'two-factor-enabled', 'two-factor-disabled', 'recovery-code-used', 'recovery-codes-regenerated', 'provider-linked', 'provider-unlinked', 'passkey-added', 'passkey-removed', 'token-created', 'signed-out-everywhere', 'account-deleted', 'organization-handed-over'] as const

export type AuthLinkKind = typeof AUTH_LINK_KINDS[number]
export type AuthNoticeKind = typeof AUTH_NOTICE_KINDS[number]
export type AuthMailKind = AuthLinkKind | AuthNoticeKind

// What a mail is written from: the site's `name`, the address written to, the link and the code when the mail carries them, and the provider or token an event is about, or the organization an invitation is to.
export interface AuthMailData {
  name: string
  email: string
  url?: string | undefined
  code?: string | undefined
  detail?: string | undefined
  // The language to write in, one of the `locales` option's.
  locale: string
  // How many seconds the mail's link and its code work, for the ones it carries: `{ link: 86400, code: 600 }`. `lifetime(seconds, locale)` words them.
  maxAge?: { link?: number, code?: number } | undefined
}

const LINK = 'https://example.com/auth?token=sample'
const CODE = '482913'

// What a sample of each kind carries beyond the site and the address, as kayjs-auth fills it.
export const AUTH_MAIL_SAMPLES: Readonly<Record<AuthMailKind, Pick<AuthMailData, 'url' | 'code' | 'detail'>>> = {
  'verify-email': { url: LINK, code: CODE },
  'reset-password': { url: LINK },
  'magic-link': { url: LINK, code: CODE },
  'change-email': { url: LINK },
  'invitation': { url: 'https://example.com/invitation?invitation=sample', detail: 'Acme' },
  'account-exists': { url: 'https://example.com/sign-in' },
  'new-sign-in': { url: 'https://example.com/account/sessions' },
  'sign-in-locked': {},
  'password-changed': {},
  'email-changed': { detail: 'ada@example.org' },
  'two-factor-enabled': {},
  'two-factor-disabled': {},
  'recovery-code-used': {},
  'recovery-codes-regenerated': {},
  'provider-linked': { detail: 'GitHub' },
  'provider-unlinked': { detail: 'GitHub' },
  'passkey-added': { detail: 'Laptop' },
  'passkey-removed': { detail: 'Laptop' },
  'token-created': { detail: 'Deploys' },
  'signed-out-everywhere': {},
  'account-deleted': {},
  'organization-handed-over': { detail: 'Acme' },
}

// A link's lines: `lasts` is how long it works when kayjs-auth sends no figure, empty to leave it unsaid.
export interface AuthLinkLines { subject: string, lead: string, button: string, lasts: string, ending: string }
export interface AuthNoticeLines { subject: string, lead: string, ending: string }

// The wording of one language, shaped as kayjs-mail's `mail.auth` messages: the lines every mail shares, then each kind's. Placeholders are `{site}`, `{email}`, `{detail}`, `{what}` (`link` or `code`) and `{duration}`.
export type AuthMailWording = {
  link: string
  code: string
  orPaste: string
  yourCode: string
  orTypeCode: string
  linkWorks: string
  codeWorks: string
  codeLasts: string
  once: string
  review: string
} & Record<AuthLinkKind, AuthLinkLines> & Record<AuthNoticeKind, AuthNoticeLines>

const NOT_YOU = 'If this was not you, reset your password and check your account at once.'
const CONTACT_SITE = 'If this was not you, contact the site at once.'

export const AUTH_MAIL_ENGLISH = {
  'link': 'link',
  'code': 'code',
  'orPaste': 'Or paste this into your browser:',
  'yourCode': 'Your code:',
  'orTypeCode': 'Or type this code where you asked for it:',
  'linkWorks': 'The link works for {duration}.',
  'codeWorks': 'The code works for {duration}, typed where you asked for it.',
  'codeLasts': '10 minutes',
  'once': ', once',
  'review': 'See where your account is signed in, and end what you do not know:',
  'verify-email': { subject: 'Confirm your email for {site}', lead: 'Confirm {email} as the address of your {site} account.', button: 'Confirm my email', lasts: '24 hours', ending: 'If you did not create an account, ignore this mail.' },
  'reset-password': { subject: 'Reset your {site} password', lead: 'Someone asked to reset the password of the {site} account for {email}.', button: 'Choose a new password', lasts: 'one hour', ending: 'If you did not ask for it, ignore this mail: your password stays as it is.' },
  'magic-link': { subject: 'Sign in to {site}', lead: 'Here is your {what} to sign in to {site}.', button: 'Sign in', lasts: '15 minutes, once', ending: 'If you did not ask for it, ignore this mail.' },
  'change-email': { subject: 'Confirm your new email for {site}', lead: 'Confirm {email} as the new address of your {site} account.', button: 'Confirm the change', lasts: 'one hour', ending: 'If you did not ask for this change, ignore this mail.' },
  'invitation': { subject: 'Join {detail} on {site}', lead: 'You are invited to join {detail} on {site}, with an account at {email}.', button: 'See the invitation', lasts: '', ending: 'If you did not expect it, ignore this mail.' },
  'account-exists': { subject: 'You already have a {site} account', lead: 'Someone tried to create a {site} account for {email}, which has one already. Sign in to it, or ask for a new password on the sign-in page if you forgot yours.', button: 'Sign in', lasts: '', ending: 'If this was not you, ignore this mail: nothing changed on your account.' },
  'new-sign-in': { subject: 'New sign-in on {site}', lead: 'Your {site} account was just signed into from a device or network it had not used before.', ending: NOT_YOU },
  'sign-in-locked': { subject: 'Sign-in locked on {site}', lead: 'Too many wrong passwords or codes were tried on your {site} account, so signing in to it is paused for a while.', ending: NOT_YOU },
  'password-changed': { subject: 'Password changed on {site}', lead: 'The password of your {site} account was changed, and its other sessions signed out.', ending: NOT_YOU },
  'email-changed': { subject: 'Email changed on {site}', lead: 'Your {site} account moved from {email} to {detail}. This address no longer signs into it.', ending: CONTACT_SITE },
  'two-factor-enabled': { subject: 'Two-factor turned on on {site}', lead: 'Your {site} account now asks for a code from your authenticator when signing in.', ending: NOT_YOU },
  'two-factor-disabled': { subject: 'Two-factor turned off on {site}', lead: 'Your {site} account no longer asks for a code when signing in.', ending: NOT_YOU },
  'recovery-code-used': { subject: 'Recovery code used on {site}', lead: 'A recovery code was just used on your {site} account; it will not work again.', ending: NOT_YOU },
  'recovery-codes-regenerated': { subject: 'New recovery codes on {site}', lead: 'Your {site} account has a new set of recovery codes, and the old ones no longer work.', ending: NOT_YOU },
  'provider-linked': { subject: 'Account linked on {site}', lead: 'A {detail} account can now sign into your {site} account.', ending: NOT_YOU },
  'provider-unlinked': { subject: 'Account unlinked on {site}', lead: 'Your {detail} account no longer signs into your {site} account.', ending: NOT_YOU },
  'passkey-added': { subject: 'New passkey on {site}', lead: 'A passkey named {detail} can now sign into your {site} account.', ending: NOT_YOU },
  'passkey-removed': { subject: 'Passkey removed on {site}', lead: 'The passkey named {detail} no longer signs into your {site} account.', ending: NOT_YOU },
  'token-created': { subject: 'New access token on {site}', lead: 'An access token named {detail} was created for your {site} account.', ending: NOT_YOU },
  'signed-out-everywhere': { subject: 'Signed out everywhere on {site}', lead: 'Your {site} account was signed out everywhere: every session and access token it had has ended.', ending: NOT_YOU },
  'account-deleted': { subject: 'Account deleted on {site}', lead: 'Your {site} account was deleted.', ending: CONTACT_SITE },
  'organization-handed-over': { subject: 'You own an organization on {site}', lead: 'You are now an owner of {detail} on {site}: its only owner\'s account was deleted.', ending: CONTACT_SITE },
} as const satisfies AuthMailWording

const NOT_YOU_FR = 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.'
const CONTACT_SITE_FR = 'Si ce n\'était pas vous, contactez le site sans attendre.'

export const AUTH_MAIL_FRENCH = {
  'link': 'lien',
  'code': 'code',
  'orPaste': 'Ou collez ceci dans votre navigateur :',
  'yourCode': 'Votre code :',
  'orTypeCode': 'Ou saisissez ce code là où vous l\'avez demandé :',
  'linkWorks': 'Le lien est valable {duration}.',
  'codeWorks': 'Le code est valable {duration}, saisi là où vous l\'avez demandé.',
  'codeLasts': '10 minutes',
  'once': ', une seule fois',
  'review': 'Voyez où votre compte est connecté, et mettez fin à ce que vous ne reconnaissez pas :',
  'verify-email': { subject: 'Confirmez votre adresse pour {site}', lead: 'Confirmez {email} comme adresse de votre compte {site}.', button: 'Confirmer mon adresse', lasts: '24 heures', ending: 'Si vous n\'avez pas créé de compte, ignorez ce message.' },
  'reset-password': { subject: 'Réinitialisez votre mot de passe {site}', lead: 'Quelqu\'un a demandé à réinitialiser le mot de passe du compte {site} de {email}.', button: 'Choisir un nouveau mot de passe', lasts: 'une heure', ending: 'Si vous ne l\'avez pas demandé, ignorez ce message : votre mot de passe reste inchangé.' },
  'magic-link': { subject: 'Connexion à {site}', lead: 'Voici votre {what} pour vous connecter à {site}.', button: 'Me connecter', lasts: '15 minutes, une seule fois', ending: 'Si vous ne l\'avez pas demandé, ignorez ce message.' },
  'change-email': { subject: 'Confirmez votre nouvelle adresse pour {site}', lead: 'Confirmez {email} comme nouvelle adresse de votre compte {site}.', button: 'Confirmer le changement', lasts: 'une heure', ending: 'Si vous n\'avez pas demandé ce changement, ignorez ce message.' },
  'invitation': { subject: 'Rejoignez {detail} sur {site}', lead: 'Vous êtes invité à rejoindre {detail} sur {site}, avec un compte à l\'adresse {email}.', button: 'Voir l\'invitation', lasts: '', ending: 'Si vous ne l\'attendiez pas, ignorez ce message.' },
  'account-exists': { subject: 'Vous avez déjà un compte {site}', lead: 'Quelqu\'un a tenté de créer un compte {site} pour {email}, qui en a déjà un. Connectez-vous-y, ou demandez un nouveau mot de passe depuis la page de connexion si vous l\'avez oublié.', button: 'Me connecter', lasts: '', ending: 'Si ce n\'était pas vous, ignorez ce message : rien n\'a changé sur votre compte.' },
  'new-sign-in': { subject: 'Nouvelle connexion sur {site}', lead: 'Votre compte {site} vient d\'être utilisé depuis un appareil ou un réseau qu\'il n\'avait jamais utilisé.', ending: NOT_YOU_FR },
  'sign-in-locked': { subject: 'Connexion suspendue sur {site}', lead: 'Trop de mots de passe ou de codes incorrects ont été essayés sur votre compte {site} : la connexion est suspendue pour un moment.', ending: NOT_YOU_FR },
  'password-changed': { subject: 'Mot de passe modifié sur {site}', lead: 'Le mot de passe de votre compte {site} a été modifié, et ses autres sessions déconnectées.', ending: NOT_YOU_FR },
  'email-changed': { subject: 'Adresse modifiée sur {site}', lead: 'Votre compte {site} est passé de {email} à {detail}. Cette adresse ne permet plus de s\'y connecter.', ending: CONTACT_SITE_FR },
  'two-factor-enabled': { subject: 'Double authentification activée sur {site}', lead: 'Votre compte {site} demande désormais un code de votre application d\'authentification à chaque connexion.', ending: NOT_YOU_FR },
  'two-factor-disabled': { subject: 'Double authentification désactivée sur {site}', lead: 'Votre compte {site} ne demande plus de code à la connexion.', ending: NOT_YOU_FR },
  'recovery-code-used': { subject: 'Code de secours utilisé sur {site}', lead: 'Un code de secours vient d\'être utilisé sur votre compte {site} ; il ne fonctionnera plus.', ending: NOT_YOU_FR },
  'recovery-codes-regenerated': { subject: 'Nouveaux codes de secours sur {site}', lead: 'Votre compte {site} a de nouveaux codes de secours, et les anciens ne fonctionnent plus.', ending: NOT_YOU_FR },
  'provider-linked': { subject: 'Compte associé sur {site}', lead: 'Un compte {detail} peut désormais se connecter à votre compte {site}.', ending: NOT_YOU_FR },
  'provider-unlinked': { subject: 'Compte dissocié sur {site}', lead: 'Votre compte {detail} ne permet plus de se connecter à votre compte {site}.', ending: NOT_YOU_FR },
  'passkey-added': { subject: 'Nouvelle clé d\'accès sur {site}', lead: 'Une clé d\'accès nommée {detail} peut désormais se connecter à votre compte {site}.', ending: NOT_YOU_FR },
  'passkey-removed': { subject: 'Clé d\'accès supprimée sur {site}', lead: 'La clé d\'accès nommée {detail} ne permet plus de se connecter à votre compte {site}.', ending: NOT_YOU_FR },
  'token-created': { subject: 'Nouveau jeton d\'accès sur {site}', lead: 'Un jeton d\'accès nommé {detail} a été créé pour votre compte {site}.', ending: NOT_YOU_FR },
  'signed-out-everywhere': { subject: 'Déconnexion partout sur {site}', lead: 'Votre compte {site} a été déconnecté partout : toutes ses sessions et tous ses jetons d\'accès ont pris fin.', ending: NOT_YOU_FR },
  'account-deleted': { subject: 'Compte supprimé sur {site}', lead: 'Votre compte {site} a été supprimé.', ending: CONTACT_SITE_FR },
  'organization-handed-over': { subject: 'Vous dirigez une organisation sur {site}', lead: 'Vous êtes désormais propriétaire de {detail} sur {site} : le compte de son seul propriétaire a été supprimé.', ending: CONTACT_SITE_FR },
} as const satisfies AuthMailWording

// The wording by language, the ones kayjs-auth and kayjs-mail ship.
export const AUTH_MAIL_WORDING: Readonly<Record<string, AuthMailWording>> = { en: AUTH_MAIL_ENGLISH, fr: AUTH_MAIL_FRENCH }
