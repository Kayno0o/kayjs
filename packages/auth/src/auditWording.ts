import type { AuditEntry, AuthEvent } from './events'
import { language } from './locale'

// How one event reads, given the entry's detail: a role, a provider, a passkey's name, how a sign-in happened.
export type AuditPhrase = string | ((detail: string | null) => string)

export type AuditWording = Record<AuthEvent, AuditPhrase>

const OAUTH_PREFIX = 'oauth:'

// The roles an organization event names after the organization's id, space-separated.
function orgRoles(detail: string | null): string | null {
  const roles = detail?.split(' ').slice(1).join(', ')

  return roles === undefined || roles === '' ? null : roles
}

// Names the detail, as `read` gives it, in the phrase when there is one, else says the plain phrase.
function naming(named: (detail: string) => string, plain: string, read: (detail: string | null) => string | null = detail => detail == null || detail === '' ? null : detail): AuditPhrase {
  return (detail) => {
    const shown = read(detail)

    return shown === null ? plain : named(shown)
  }
}

const ENGLISH_SIGN_INS: Record<string, string> = {
  'password': 'with a password',
  'register': 'on creating the account',
  'reset-password': 'after a password reset',
  'magic-link': 'with a mailed link',
  'email-code': 'with a mailed code',
  'passkey': 'with a passkey',
  'guest': 'as a guest',
}

const FRENCH_SIGN_INS: Record<string, string> = {
  'password': 'avec un mot de passe',
  'register': 'à la création du compte',
  'reset-password': 'après une réinitialisation du mot de passe',
  'magic-link': 'avec un lien reçu par e-mail',
  'email-code': 'avec un code reçu par e-mail',
  'passkey': 'avec une clé d’accès',
  'guest': 'en invité',
}

// The phrase a detail maps to in `phrases`, or `fallback` when it maps to none.
function byDetail(phrases: Record<string, string>, fallback: string): AuditPhrase {
  return detail => (detail !== null && Object.hasOwn(phrases, detail) ? phrases[detail] : undefined) ?? fallback
}

function signedIn(label: string, methods: Record<string, string>, provider: (name: string) => string) {
  return (detail: string | null) => {
    if (detail?.startsWith(OAUTH_PREFIX))
      return `${label} ${provider(detail.slice(OAUTH_PREFIX.length))}`

    const how = detail === null ? undefined : methods[detail]

    return how === undefined ? label : `${label} ${how}`
  }
}

const english: AuditWording = {
  'signed-in': signedIn('Signed in', ENGLISH_SIGN_INS, name => `with ${name}`),
  // Before 0.15, signing out everywhere was a `signed-out` with this detail.
  'signed-out': byDetail({ 'everywhere': 'Signed out everywhere', 'everywhere-else': 'Signed out everywhere else' }, 'Signed out'),
  'signed-out-everywhere': detail => detail === 'this-one-kept' ? 'Signed out everywhere else' : 'Signed out everywhere',
  'sign-in-failed': byDetail({ 'two-factor': 'Failed sign-in: wrong code', 'passkey': 'Failed sign-in: passkey refused' }, 'Failed sign-in: wrong password'),
  'new-sign-in': 'Signed in from a new device or network',
  'sign-in-locked': 'Sign-in locked after too many wrong passwords or codes',
  'password-changed': 'Password changed',
  'email-changed': naming(detail => `Email changed to ${detail}`, 'Email changed'),
  'two-factor-enabled': 'Two-step verification turned on',
  'two-factor-disabled': 'Two-step verification turned off',
  'recovery-code-used': 'Recovery code used',
  'recovery-codes-regenerated': 'New recovery codes',
  'provider-linked': naming(detail => `${detail} account linked`, 'Account linked'),
  'provider-unlinked': naming(detail => `${detail} account unlinked`, 'Account unlinked'),
  'passkey-added': naming(detail => `Passkey “${detail}” added`, 'Passkey added'),
  'passkey-removed': naming(detail => `Passkey “${detail}” removed`, 'Passkey removed'),
  'token-created': naming(detail => `Access token “${detail}” created`, 'Access token created'),
  'account-deleted': 'Account deleted',
  'organization-handed-over': 'Became an owner of an organization whose last owner left',
  'role-granted': naming(detail => `Role ${detail} granted`, 'Role granted'),
  'role-revoked': naming(detail => `Role ${detail} revoked`, 'Role revoked'),
  'banned': naming(detail => `Suspended: ${detail}`, 'Suspended'),
  'unbanned': 'Suspension lifted',
  'impersonation-started': 'An admin started acting as the account',
  'impersonation-ended': 'An admin stopped acting as the account',
  'organization-created': 'Organization created',
  'organization-deleted': 'Organization deleted',
  'member-joined': naming(roles => `Joined an organization as ${roles}`, 'Joined an organization', orgRoles),
  'member-left': 'Left an organization',
  'member-removed': 'Removed from an organization',
  'oauth-client-approved': naming(detail => `${detail} was given access`, 'An app was given access'),
  'oauth-client-revoked': naming(detail => `${detail} lost access`, 'An app lost access'),
  'member-roles-changed': naming(roles => `Organization roles changed to ${roles}`, 'Organization roles changed', orgRoles),
}

const french: AuditWording = {
  'signed-in': signedIn('Connexion', FRENCH_SIGN_INS, name => `avec ${name}`),
  'signed-out': byDetail({ 'everywhere': 'Déconnexion partout', 'everywhere-else': 'Déconnexion de tous les autres appareils' }, 'Déconnexion'),
  'signed-out-everywhere': detail => detail === 'this-one-kept' ? 'Déconnexion de tous les autres appareils' : 'Déconnexion partout',
  'sign-in-failed': byDetail({ 'two-factor': 'Échec de connexion : code incorrect', 'passkey': 'Échec de connexion : clé d’accès refusée' }, 'Échec de connexion : mot de passe incorrect'),
  'new-sign-in': 'Connexion depuis un nouvel appareil ou réseau',
  'sign-in-locked': 'Connexion suspendue après trop de mots de passe ou de codes incorrects',
  'password-changed': 'Mot de passe modifié',
  'email-changed': naming(detail => `Adresse changée pour ${detail}`, 'Adresse modifiée'),
  'two-factor-enabled': 'Validation en deux étapes activée',
  'two-factor-disabled': 'Validation en deux étapes désactivée',
  'recovery-code-used': 'Code de secours utilisé',
  'recovery-codes-regenerated': 'Nouveaux codes de secours',
  'provider-linked': naming(detail => `Compte ${detail} associé`, 'Compte associé'),
  'provider-unlinked': naming(detail => `Compte ${detail} dissocié`, 'Compte dissocié'),
  'passkey-added': naming(detail => `Clé d’accès « ${detail} » ajoutée`, 'Clé d’accès ajoutée'),
  'passkey-removed': naming(detail => `Clé d’accès « ${detail} » supprimée`, 'Clé d’accès supprimée'),
  'token-created': naming(detail => `Jeton d’accès « ${detail} » créé`, 'Jeton d’accès créé'),
  'account-deleted': 'Compte supprimé',
  'organization-handed-over': 'Devenu propriétaire d’une organisation dont le dernier propriétaire est parti',
  'role-granted': naming(detail => `Rôle ${detail} accordé`, 'Rôle accordé'),
  'role-revoked': naming(detail => `Rôle ${detail} retiré`, 'Rôle retiré'),
  'banned': naming(detail => `Compte suspendu : ${detail}`, 'Compte suspendu'),
  'unbanned': 'Suspension levée',
  'impersonation-started': 'Un administrateur agit en tant que ce compte',
  'impersonation-ended': 'Un administrateur a cessé d’agir en tant que ce compte',
  'organization-created': 'Organisation créée',
  'organization-deleted': 'Organisation supprimée',
  'member-joined': naming(roles => `Organisation rejointe en tant que ${roles}`, 'Organisation rejointe', orgRoles),
  'member-left': 'Organisation quittée',
  'member-removed': 'Retiré d’une organisation',
  'oauth-client-approved': naming(detail => `${detail} a reçu un accès`, 'Une application a reçu un accès'),
  'oauth-client-revoked': naming(detail => `${detail} a perdu son accès`, 'Une application a perdu son accès'),
  'member-roles-changed': naming(roles => `Rôles dans l’organisation changés pour ${roles}`, 'Rôles dans l’organisation changés', orgRoles),
}

// kayjs-auth's wording of the audit log by language, the ones its pages ship.
export const auditWording: Record<string, AuditWording> = { en: english, fr: french }

// An audit entry as a person reads it, in `locale`'s language (English for any kayjs-auth does not ship), `wording` over kayjs-auth's for any event the app words its own way.
export function describeAuditEntry(entry: Pick<AuditEntry, 'event' | 'detail'>, options: { locale?: string | undefined, wording?: Partial<AuditWording> | undefined } = {}): string {
  const phrase = options.wording?.[entry.event] ?? (auditWording[language(options.locale ?? 'en')] ?? english)[entry.event]

  if (phrase === undefined)
    return entry.event

  return typeof phrase === 'string' ? phrase : phrase(entry.detail)
}
