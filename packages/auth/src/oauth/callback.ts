import type { OAuthTokens } from './types'

/** The subset of an OAuth client `handleOAuthCallback` needs. */
export interface OAuthCallbackClient<User> {
  exchangeCode: (code: string, opts?: { codeVerifier?: string }) => Promise<OAuthTokens>
  fetchUser: (accessToken: string) => Promise<User>
}

export interface HandleCallbackDeps<User, AppUser, Session, StatePayload> {
  code: string
  state: string
  /** Verifies/decodes `state` before the code is spent (required - fail closed on CSRF). */
  verifyState: (state: string) => Promise<StatePayload> | StatePayload
  /** The PKCE code verifier bound to this login attempt, replayed on code exchange. */
  codeVerifier?: string
  /** Links the provider identity to an app user and persists the tokens. */
  upsertUser: (user: User, tokens: OAuthTokens) => Promise<AppUser> | AppUser
  /** Issues the app session (e.g. signs a JWT) for the resolved user. */
  issueSession: (user: AppUser) => Promise<Session> | Session
}

export interface OAuthCallbackResult<AppUser, Session, StatePayload> {
  user: AppUser
  session: Session
  tokens: OAuthTokens
  state: StatePayload
}

/** Runs the OAuth authorization-code callback: verify state -> exchange code -> fetch user -> upsert user -> issue session. */
export async function handleOAuthCallback<User, AppUser, Session, StatePayload = unknown>(
  client: OAuthCallbackClient<User>,
  deps: HandleCallbackDeps<User, AppUser, Session, StatePayload>,
): Promise<OAuthCallbackResult<AppUser, Session, StatePayload>> {
  const state = await deps.verifyState(deps.state)
  const tokens = await client.exchangeCode(deps.code, { codeVerifier: deps.codeVerifier })
  const providerUser = await client.fetchUser(tokens.accessToken)
  const user = await deps.upsertUser(providerUser, tokens)
  const session = await deps.issueSession(user)

  return { user, session, tokens, state }
}

/** True if the string holds a C0 control char or DEL - things browsers strip/normalize in URLs. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)

    if (c < 0x20 || c === 0x7F)
      return true
  }

  return false
}

/** Guards a redirect target to a same-origin absolute path (`/...`), else returns `fallback`; rejects protocol-relative and control-laced targets. */
export function safeRedirect(path: string | undefined | null, fallback = '/'): string {
  if (!path)
    return fallback

  // Browsers strip tab/newline anywhere in a URL; mirror that before validating.
  const cleaned = path.replace(/[\t\n\r]/g, '').replace(/^\s+/, '')

  if (cleaned.startsWith('/') && !cleaned.startsWith('//') && !cleaned.includes('\\') && !hasControlChar(cleaned))
    return cleaned

  return fallback
}
