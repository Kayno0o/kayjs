import type { AdminMethods } from './methods/admin'
import type { EmailMethods } from './methods/email'
import type { MagicLinkMethods } from './methods/magicLink'
import type { OAuthServerMethods } from './methods/oauthServer'
import type { OrganizationMethods } from './methods/organizations'
import type { PasskeyMethods } from './methods/passkeys'
import type { PasswordMethods } from './methods/password'
import type { SessionMethods } from './methods/sessions'
import type { TokenMethods } from './methods/tokens'
import type { TwoFactorMethods } from './methods/twoFactor'

// The flat methods `Auth` had before 1.82, each calling the grouped method it became; they go in 1.85, and `kay upgrade` (`deprecated-auth-methods`) moves an app off them.
export abstract class FlatMethods<Scope extends string, Role extends string, OrgRole extends string> {
  abstract get password(): PasswordMethods
  abstract get email(): EmailMethods
  abstract get magicLink(): MagicLinkMethods
  abstract get twoFactor(): TwoFactorMethods
  abstract get passkeys(): PasskeyMethods
  abstract get sessions(): SessionMethods
  abstract get tokens(): TokenMethods<Scope>
  abstract get oauthServer(): OAuthServerMethods
  abstract get admin(): AdminMethods<Role>
  abstract get organizations(): OrganizationMethods<OrgRole>

  /** @deprecated since 1.82: `auth.password.register` */
  async register(...args: Parameters<PasswordMethods['register']>): ReturnType<PasswordMethods['register']> {
    return this.password.register(...args)
  }

  /** @deprecated since 1.82: `auth.password.signIn` */
  async signInWithPassword(...args: Parameters<PasswordMethods['signIn']>): ReturnType<PasswordMethods['signIn']> {
    return this.password.signIn(...args)
  }

  /** @deprecated since 1.82: `auth.password.requestReset` */
  async requestPasswordReset(...args: Parameters<PasswordMethods['requestReset']>): ReturnType<PasswordMethods['requestReset']> {
    return this.password.requestReset(...args)
  }

  /** @deprecated since 1.82: `auth.password.reset` */
  async resetPassword(...args: Parameters<PasswordMethods['reset']>): ReturnType<PasswordMethods['reset']> {
    return this.password.reset(...args)
  }

  /** @deprecated since 1.82: `auth.password.change` */
  async changePassword(...args: Parameters<PasswordMethods['change']>): ReturnType<PasswordMethods['change']> {
    return this.password.change(...args)
  }

  /** @deprecated since 1.82: `auth.email.sendVerification` */
  async sendVerification(...args: Parameters<EmailMethods['sendVerification']>): ReturnType<EmailMethods['sendVerification']> {
    return this.email.sendVerification(...args)
  }

  /** @deprecated since 1.82: `auth.email.verify` */
  async verifyEmail(...args: Parameters<EmailMethods['verify']>): ReturnType<EmailMethods['verify']> {
    return this.email.verify(...args)
  }

  /** @deprecated since 1.82: `auth.email.verifyCode` */
  async verifyEmailCode(...args: Parameters<EmailMethods['verifyCode']>): ReturnType<EmailMethods['verifyCode']> {
    return this.email.verifyCode(...args)
  }

  /** @deprecated since 1.82: `auth.email.pendingCode` */
  async emailCodePending(...args: Parameters<EmailMethods['pendingCode']>): ReturnType<EmailMethods['pendingCode']> {
    return this.email.pendingCode(...args)
  }

  /** @deprecated since 1.82: `auth.email.change` */
  async changeEmail(...args: Parameters<EmailMethods['change']>): ReturnType<EmailMethods['change']> {
    return this.email.change(...args)
  }

  /** @deprecated since 1.82: `auth.email.confirmChange` */
  async confirmEmailChange(...args: Parameters<EmailMethods['confirmChange']>): ReturnType<EmailMethods['confirmChange']> {
    return this.email.confirmChange(...args)
  }

  /** @deprecated since 1.82: `auth.magicLink.request` */
  async requestMagicLink(...args: Parameters<MagicLinkMethods['request']>): ReturnType<MagicLinkMethods['request']> {
    return this.magicLink.request(...args)
  }

  /** @deprecated since 1.82: `auth.magicLink.signIn` */
  async signInWithMagicLink(...args: Parameters<MagicLinkMethods['signIn']>): ReturnType<MagicLinkMethods['signIn']> {
    return this.magicLink.signIn(...args)
  }

  /** @deprecated since 1.82: `auth.magicLink.signInWithCode` */
  async signInWithEmailCode(...args: Parameters<MagicLinkMethods['signInWithCode']>): ReturnType<MagicLinkMethods['signInWithCode']> {
    return this.magicLink.signInWithCode(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.pending` */
  async twoFactorPending(...args: Parameters<TwoFactorMethods['pending']>): ReturnType<TwoFactorMethods['pending']> {
    return this.twoFactor.pending(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.verify` */
  async verifyTwoFactor(...args: Parameters<TwoFactorMethods['verify']>): ReturnType<TwoFactorMethods['verify']> {
    return this.twoFactor.verify(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.setUp` */
  async setUpTwoFactor(...args: Parameters<TwoFactorMethods['setUp']>): ReturnType<TwoFactorMethods['setUp']> {
    return this.twoFactor.setUp(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.enable` */
  async enableTwoFactor(...args: Parameters<TwoFactorMethods['enable']>): ReturnType<TwoFactorMethods['enable']> {
    return this.twoFactor.enable(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.disable` */
  async disableTwoFactor(...args: Parameters<TwoFactorMethods['disable']>): ReturnType<TwoFactorMethods['disable']> {
    return this.twoFactor.disable(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.regenerateRecoveryCodes` */
  async regenerateRecoveryCodes(...args: Parameters<TwoFactorMethods['regenerateRecoveryCodes']>): ReturnType<TwoFactorMethods['regenerateRecoveryCodes']> {
    return this.twoFactor.regenerateRecoveryCodes(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.recoveryCodesLeft` */
  async recoveryCodesLeft(...args: Parameters<TwoFactorMethods['recoveryCodesLeft']>): ReturnType<TwoFactorMethods['recoveryCodesLeft']> {
    return this.twoFactor.recoveryCodesLeft(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.passkeyOptions` */
  async twoFactorPasskeyOptions(...args: Parameters<TwoFactorMethods['passkeyOptions']>): ReturnType<TwoFactorMethods['passkeyOptions']> {
    return this.twoFactor.passkeyOptions(...args)
  }

  /** @deprecated since 1.82: `auth.twoFactor.verifyPasskey` */
  async verifyTwoFactorPasskey(...args: Parameters<TwoFactorMethods['verifyPasskey']>): ReturnType<TwoFactorMethods['verifyPasskey']> {
    return this.twoFactor.verifyPasskey(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.registrationOptions` */
  async passkeyRegistrationOptions(...args: Parameters<PasskeyMethods['registrationOptions']>): ReturnType<PasskeyMethods['registrationOptions']> {
    return this.passkeys.registrationOptions(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.register` */
  async registerPasskey(...args: Parameters<PasskeyMethods['register']>): ReturnType<PasskeyMethods['register']> {
    return this.passkeys.register(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.list` */
  async listPasskeys(...args: Parameters<PasskeyMethods['list']>): ReturnType<PasskeyMethods['list']> {
    return this.passkeys.list(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.rename` */
  async updatePasskeyName(...args: Parameters<PasskeyMethods['rename']>): ReturnType<PasskeyMethods['rename']> {
    return this.passkeys.rename(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.revoke` */
  async revokePasskey(...args: Parameters<PasskeyMethods['revoke']>): ReturnType<PasskeyMethods['revoke']> {
    return this.passkeys.revoke(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.signInOptions` */
  async passkeySignInOptions(...args: Parameters<PasskeyMethods['signInOptions']>): ReturnType<PasskeyMethods['signInOptions']> {
    return this.passkeys.signInOptions(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.signIn` */
  async signInWithPasskey(...args: Parameters<PasskeyMethods['signIn']>): ReturnType<PasskeyMethods['signIn']> {
    return this.passkeys.signIn(...args)
  }

  /** @deprecated since 1.82: `auth.passkeys.proofOptions` */
  async passkeyProofOptions(...args: Parameters<PasskeyMethods['proofOptions']>): ReturnType<PasskeyMethods['proofOptions']> {
    return this.passkeys.proofOptions(...args)
  }

  /** @deprecated since 1.82: `auth.sessions.list` */
  async listSessions(...args: Parameters<SessionMethods['list']>): ReturnType<SessionMethods['list']> {
    return this.sessions.list(...args)
  }

  /** @deprecated since 1.82: `auth.sessions.revoke` */
  async revokeSession(...args: Parameters<SessionMethods['revoke']>): ReturnType<SessionMethods['revoke']> {
    return this.sessions.revoke(...args)
  }

  /** @deprecated since 1.82: `auth.tokens.create` */
  async createToken(...args: Parameters<TokenMethods<Scope>['create']>): ReturnType<TokenMethods<Scope>['create']> {
    return this.tokens.create(...args)
  }

  /** @deprecated since 1.82: `auth.tokens.list` */
  async listTokens(...args: Parameters<TokenMethods<Scope>['list']>): ReturnType<TokenMethods<Scope>['list']> {
    return this.tokens.list(...args)
  }

  /** @deprecated since 1.82: `auth.tokens.revoke` */
  async revokeBearerToken(...args: Parameters<TokenMethods<Scope>['revoke']>): ReturnType<TokenMethods<Scope>['revoke']> {
    return this.tokens.revoke(...args)
  }

  /** @deprecated since 1.82: `auth.oauthServer.authorize` */
  async oauthAuthorize(...args: Parameters<OAuthServerMethods['authorize']>): ReturnType<OAuthServerMethods['authorize']> {
    return this.oauthServer.authorize(...args)
  }

  /** @deprecated since 1.82: `auth.oauthServer.decide` */
  async oauthDecide(...args: Parameters<OAuthServerMethods['decide']>): ReturnType<OAuthServerMethods['decide']> {
    return this.oauthServer.decide(...args)
  }

  /** @deprecated since 1.82: `auth.oauthServer.clients` */
  async listOAuthClients(...args: Parameters<OAuthServerMethods['clients']>): ReturnType<OAuthServerMethods['clients']> {
    return this.oauthServer.clients(...args)
  }

  /** @deprecated since 1.82: `auth.oauthServer.revokeGrant` */
  async revokeOAuthGrant(...args: Parameters<OAuthServerMethods['revokeGrant']>): ReturnType<OAuthServerMethods['revokeGrant']> {
    return this.oauthServer.revokeGrant(...args)
  }

  /** @deprecated since 1.82: `auth.admin.listUsers` */
  async listUsers(...args: Parameters<AdminMethods<Role>['listUsers']>): ReturnType<AdminMethods<Role>['listUsers']> {
    return this.admin.listUsers(...args)
  }

  /** @deprecated since 1.82: `auth.admin.getUser` */
  async getUser(...args: Parameters<AdminMethods<Role>['getUser']>): ReturnType<AdminMethods<Role>['getUser']> {
    return this.admin.getUser(...args)
  }

  /** @deprecated since 1.82: `auth.admin.roles` */
  adminRoles(...args: Parameters<AdminMethods<Role>['roles']>): ReturnType<AdminMethods<Role>['roles']> {
    return this.admin.roles(...args)
  }

  /** @deprecated since 1.82: `auth.admin.grantRole` */
  async grantRole(...args: Parameters<AdminMethods<Role>['grantRole']>): ReturnType<AdminMethods<Role>['grantRole']> {
    return this.admin.grantRole(...args)
  }

  /** @deprecated since 1.82: `auth.admin.revokeRole` */
  async revokeRole(...args: Parameters<AdminMethods<Role>['revokeRole']>): ReturnType<AdminMethods<Role>['revokeRole']> {
    return this.admin.revokeRole(...args)
  }

  /** @deprecated since 1.82: `auth.admin.ban` */
  async banUser(...args: Parameters<AdminMethods<Role>['ban']>): ReturnType<AdminMethods<Role>['ban']> {
    return this.admin.ban(...args)
  }

  /** @deprecated since 1.82: `auth.admin.unban` */
  async unbanUser(...args: Parameters<AdminMethods<Role>['unban']>): ReturnType<AdminMethods<Role>['unban']> {
    return this.admin.unban(...args)
  }

  /** @deprecated since 1.82: `auth.admin.deleteUser` */
  async deleteUser(...args: Parameters<AdminMethods<Role>['deleteUser']>): ReturnType<AdminMethods<Role>['deleteUser']> {
    return this.admin.deleteUser(...args)
  }

  /** @deprecated since 1.82: `auth.admin.auditLog` */
  async listAdminAuditLog(...args: Parameters<AdminMethods<Role>['auditLog']>): ReturnType<AdminMethods<Role>['auditLog']> {
    return this.admin.auditLog(...args)
  }

  /** @deprecated since 1.82: `auth.admin.impersonate` */
  async impersonate(...args: Parameters<AdminMethods<Role>['impersonate']>): ReturnType<AdminMethods<Role>['impersonate']> {
    return this.admin.impersonate(...args)
  }

  /** @deprecated since 1.82: `auth.admin.stopImpersonating` */
  async stopImpersonating(...args: Parameters<AdminMethods<Role>['stopImpersonating']>): ReturnType<AdminMethods<Role>['stopImpersonating']> {
    return this.admin.stopImpersonating(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.create` */
  async createOrganization(...args: Parameters<OrganizationMethods<OrgRole>['create']>): ReturnType<OrganizationMethods<OrgRole>['create']> {
    return this.organizations.create(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.list` */
  async listOrganizations(...args: Parameters<OrganizationMethods<OrgRole>['list']>): ReturnType<OrganizationMethods<OrgRole>['list']> {
    return this.organizations.list(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.get` */
  async getOrganization(...args: Parameters<OrganizationMethods<OrgRole>['get']>): ReturnType<OrganizationMethods<OrgRole>['get']> {
    return this.organizations.get(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.isMember` */
  async isMember(...args: Parameters<OrganizationMethods<OrgRole>['isMember']>): ReturnType<OrganizationMethods<OrgRole>['isMember']> {
    return this.organizations.isMember(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.update` */
  async updateOrganization(...args: Parameters<OrganizationMethods<OrgRole>['update']>): ReturnType<OrganizationMethods<OrgRole>['update']> {
    return this.organizations.update(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.delete` */
  async deleteOrganization(...args: Parameters<OrganizationMethods<OrgRole>['delete']>): ReturnType<OrganizationMethods<OrgRole>['delete']> {
    return this.organizations.delete(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.members` */
  async listMembers(...args: Parameters<OrganizationMethods<OrgRole>['members']>): ReturnType<OrganizationMethods<OrgRole>['members']> {
    return this.organizations.members(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.setMemberRoles` */
  async setMemberRoles(...args: Parameters<OrganizationMethods<OrgRole>['setMemberRoles']>): ReturnType<OrganizationMethods<OrgRole>['setMemberRoles']> {
    return this.organizations.setMemberRoles(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.removeMember` */
  async deleteMember(...args: Parameters<OrganizationMethods<OrgRole>['removeMember']>): ReturnType<OrganizationMethods<OrgRole>['removeMember']> {
    return this.organizations.removeMember(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.leave` */
  async leaveOrganization(...args: Parameters<OrganizationMethods<OrgRole>['leave']>): ReturnType<OrganizationMethods<OrgRole>['leave']> {
    return this.organizations.leave(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.invite` */
  async invite(...args: Parameters<OrganizationMethods<OrgRole>['invite']>): ReturnType<OrganizationMethods<OrgRole>['invite']> {
    return this.organizations.invite(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.invitations` */
  async listInvitations(...args: Parameters<OrganizationMethods<OrgRole>['invitations']>): ReturnType<OrganizationMethods<OrgRole>['invitations']> {
    return this.organizations.invitations(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.revokeInvitation` */
  async revokeInvitation(...args: Parameters<OrganizationMethods<OrgRole>['revokeInvitation']>): ReturnType<OrganizationMethods<OrgRole>['revokeInvitation']> {
    return this.organizations.revokeInvitation(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.myInvitations` */
  async listMyInvitations(...args: Parameters<OrganizationMethods<OrgRole>['myInvitations']>): ReturnType<OrganizationMethods<OrgRole>['myInvitations']> {
    return this.organizations.myInvitations(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.invitation` */
  async getInvitation(...args: Parameters<OrganizationMethods<OrgRole>['invitation']>): ReturnType<OrganizationMethods<OrgRole>['invitation']> {
    return this.organizations.invitation(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.acceptInvitation` */
  async acceptInvitation(...args: Parameters<OrganizationMethods<OrgRole>['acceptInvitation']>): ReturnType<OrganizationMethods<OrgRole>['acceptInvitation']> {
    return this.organizations.acceptInvitation(...args)
  }

  /** @deprecated since 1.82: `auth.organizations.rejectInvitation` */
  async rejectInvitation(...args: Parameters<OrganizationMethods<OrgRole>['rejectInvitation']>): ReturnType<OrganizationMethods<OrgRole>['rejectInvitation']> {
    return this.organizations.rejectInvitation(...args)
  }
}
