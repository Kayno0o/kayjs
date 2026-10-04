import type Elysia from 'elysia'

/** The slice of `createTokenRefresher` this plugin drives. */
export interface TokenRefreshers<S> {
  getValidToken: (subject: S) => Promise<string | null>
}

export interface TokenRefreshPluginDeps<P, S> {
  refresher: TokenRefreshers<S>
  /** Projects the resolved principal into the refresher's subject; `null` skips refresh. */
  subject: (principal: P | null) => S | null
}

/** Derives a fresh access token per request, exposed as `token` on the context. Mount after `createAuthPlugin` so `auth.user` is resolved. */
export function createTokenRefreshPlugin<P, S>(deps: TokenRefreshPluginDeps<P, S>) {
  return (app: Elysia) =>
    app.derive({ as: 'scoped' }, async (ctx: any) => {
      const subject = deps.subject(ctx.auth?.user ?? null)
      const token = subject == null ? null : await deps.refresher.getValidToken(subject)

      return { token }
    })
}
