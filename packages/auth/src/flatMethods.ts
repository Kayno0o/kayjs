import type { AccountMethods } from './methods/account'
import type { AuditMethods } from './methods/audit'
import type { OAuthMethods } from './methods/oauth'

// The flat methods `Auth` had before 1.87, each calling the grouped method it became; they go in 1.90, and `kay upgrade` (`deprecated-auth-account-methods`) moves an app off them.
export abstract class FlatMethods {
  abstract get account(): AccountMethods
  abstract get oauth(): OAuthMethods
  abstract get audit(): AuditMethods

  /** @deprecated since 1.87: `auth.account.changeUsername` */
  async changeUsername(...args: Parameters<AccountMethods['changeUsername']>): ReturnType<AccountMethods['changeUsername']> {
    return this.account.changeUsername(...args)
  }

  /** @deprecated since 1.87: `auth.account.delete` */
  async deleteAccount(...args: Parameters<AccountMethods['delete']>): ReturnType<AccountMethods['delete']> {
    return this.account.delete(...args)
  }

  /** @deprecated since 1.87: `auth.account.deletionImpact` */
  async deletionImpact(...args: Parameters<AccountMethods['deletionImpact']>): ReturnType<AccountMethods['deletionImpact']> {
    return this.account.deletionImpact(...args)
  }

  /** @deprecated since 1.87: `auth.account.updateLocale` */
  async updateLocale(...args: Parameters<AccountMethods['updateLocale']>): ReturnType<AccountMethods['updateLocale']> {
    return this.account.updateLocale(...args)
  }

  /** @deprecated since 1.87: `auth.account.profile` */
  async profile(...args: Parameters<AccountMethods['profile']>): ReturnType<AccountMethods['profile']> {
    return this.account.profile(...args)
  }

  /** @deprecated since 1.87: `auth.account.saveProfile` */
  async saveProfile(...args: Parameters<AccountMethods['saveProfile']>): ReturnType<AccountMethods['saveProfile']> {
    return this.account.saveProfile(...args)
  }

  /** @deprecated since 1.87: `auth.account.export` */
  async exportData(...args: Parameters<AccountMethods['export']>): ReturnType<AccountMethods['export']> {
    return this.account.export(...args)
  }

  /** @deprecated since 1.87: `auth.oauth.link` */
  async linkProvider(...args: Parameters<OAuthMethods['link']>): ReturnType<OAuthMethods['link']> {
    return this.oauth.link(...args)
  }

  /** @deprecated since 1.87: `auth.oauth.unlink` */
  async unlink(...args: Parameters<OAuthMethods['unlink']>): ReturnType<OAuthMethods['unlink']> {
    return this.oauth.unlink(...args)
  }

  /** @deprecated since 1.87: `auth.oauth.identities` */
  async listIdentities(...args: Parameters<OAuthMethods['identities']>): ReturnType<OAuthMethods['identities']> {
    return this.oauth.identities(...args)
  }

  /** @deprecated since 1.87: `auth.oauth.providerToken` */
  async providerToken(...args: Parameters<OAuthMethods['providerToken']>): ReturnType<OAuthMethods['providerToken']> {
    return this.oauth.providerToken(...args)
  }

  /** @deprecated since 1.87: `auth.audit.list` */
  async listAuditLog(...args: Parameters<AuditMethods['list']>): ReturnType<AuditMethods['list']> {
    return this.audit.list(...args)
  }
}
