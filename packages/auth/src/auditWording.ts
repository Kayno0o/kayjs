import type { AuditEntry, AuthEvent } from './events'
import { language } from './locale'

// How one event reads, given the entry's detail: a role, a provider, a passkey's name, how a sign-in happened.
export type AuditPhrase = string | ((detail: string | null) => string)

export type AuditWording = Record<AuthEvent, AuditPhrase>

const OAUTH_PREFIX = 'oauth:'

// The roles an organization event names after the organization's id, space-separated.
function orgRoles(detail: string | null): string | null {
  const roles = detail?.split(' ').slice(1).join(', ')

  return roles || null
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
  'signed-out': detail => detail === 'everywhere' ? 'Signed out everywhere' : detail === 'everywhere-else' ? 'Signed out everywhere else' : 'Signed out',
  'signed-out-everywhere': detail => detail === 'this-one-kept' ? 'Signed out everywhere else' : 'Signed out everywhere',
  'sign-in-failed': detail => detail === 'two-factor' ? 'Failed sign-in: wrong code' : detail === 'passkey' ? 'Failed sign-in: passkey refused' : 'Failed sign-in: wrong password',
  'new-sign-in': 'Signed in from a new device or network',
  'password-changed': 'Password changed',
  'email-changed': detail => detail ? `Email changed to ${detail}` : 'Email changed',
  'two-factor-enabled': 'Two-step verification turned on',
  'two-factor-disabled': 'Two-step verification turned off',
  'recovery-code-used': 'Recovery code used',
  'recovery-codes-regenerated': 'New recovery codes',
  'provider-linked': detail => detail ? `${detail} account linked` : 'Account linked',
  'provider-unlinked': detail => detail ? `${detail} account unlinked` : 'Account unlinked',
  'passkey-added': detail => detail ? `Passkey “${detail}” added` : 'Passkey added',
  'passkey-removed': detail => detail ? `Passkey “${detail}” removed` : 'Passkey removed',
  'token-created': detail => detail ? `Access token “${detail}” created` : 'Access token created',
  'account-deleted': 'Account deleted',
  'role-granted': detail => detail ? `Role ${detail} granted` : 'Role granted',
  'role-revoked': detail => detail ? `Role ${detail} revoked` : 'Role revoked',
  'banned': detail => detail ? `Suspended: ${detail}` : 'Suspended',
  'unbanned': 'Suspension lifted',
  'impersonation-started': 'An admin started acting as the account',
  'impersonation-ended': 'An admin stopped acting as the account',
  'organization-created': 'Organization created',
  'organization-deleted': 'Organization deleted',
  'member-joined': detail => orgRoles(detail) ? `Joined an organization as ${orgRoles(detail)}` : 'Joined an organization',
  'member-left': 'Left an organization',
  'member-removed': 'Removed from an organization',
  'member-roles-changed': detail => orgRoles(detail) ? `Organization roles changed to ${orgRoles(detail)}` : 'Organization roles changed',
}

const french: AuditWording = {
  'signed-in': signedIn('Connexion', FRENCH_SIGN_INS, name => `avec ${name}`),
  'signed-out': detail => detail === 'everywhere' ? 'Déconnexion partout' : detail === 'everywhere-else' ? 'Déconnexion de tous les autres appareils' : 'Déconnexion',
  'signed-out-everywhere': detail => detail === 'this-one-kept' ? 'Déconnexion de tous les autres appareils' : 'Déconnexion partout',
  'sign-in-failed': detail => detail === 'two-factor' ? 'Échec de connexion : code incorrect' : detail === 'passkey' ? 'Échec de connexion : clé d’accès refusée' : 'Échec de connexion : mot de passe incorrect',
  'new-sign-in': 'Connexion depuis un nouvel appareil ou réseau',
  'password-changed': 'Mot de passe modifié',
  'email-changed': detail => detail ? `Adresse changée pour ${detail}` : 'Adresse modifiée',
  'two-factor-enabled': 'Validation en deux étapes activée',
  'two-factor-disabled': 'Validation en deux étapes désactivée',
  'recovery-code-used': 'Code de secours utilisé',
  'recovery-codes-regenerated': 'Nouveaux codes de secours',
  'provider-linked': detail => detail ? `Compte ${detail} associé` : 'Compte associé',
  'provider-unlinked': detail => detail ? `Compte ${detail} dissocié` : 'Compte dissocié',
  'passkey-added': detail => detail ? `Clé d’accès « ${detail} » ajoutée` : 'Clé d’accès ajoutée',
  'passkey-removed': detail => detail ? `Clé d’accès « ${detail} » supprimée` : 'Clé d’accès supprimée',
  'token-created': detail => detail ? `Jeton d’accès « ${detail} » créé` : 'Jeton d’accès créé',
  'account-deleted': 'Compte supprimé',
  'role-granted': detail => detail ? `Rôle ${detail} accordé` : 'Rôle accordé',
  'role-revoked': detail => detail ? `Rôle ${detail} retiré` : 'Rôle retiré',
  'banned': detail => detail ? `Compte suspendu : ${detail}` : 'Compte suspendu',
  'unbanned': 'Suspension levée',
  'impersonation-started': 'Un administrateur agit en tant que ce compte',
  'impersonation-ended': 'Un administrateur a cessé d’agir en tant que ce compte',
  'organization-created': 'Organisation créée',
  'organization-deleted': 'Organisation supprimée',
  'member-joined': detail => orgRoles(detail) ? `Organisation rejointe en tant que ${orgRoles(detail)}` : 'Organisation rejointe',
  'member-left': 'Organisation quittée',
  'member-removed': 'Retiré d’une organisation',
  'member-roles-changed': detail => orgRoles(detail) ? `Rôles dans l’organisation changés pour ${orgRoles(detail)}` : 'Rôles dans l’organisation changés',
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
