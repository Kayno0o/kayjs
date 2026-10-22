
# kayjs-auth: Setup, pages, the signed-in user, sessions and guards

## Common tasks

### Setup

kayjs-auth is published as `@kaynooo/kayjs-auth` to `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, beside kay. kay, Elysia, kayjs-ui (for the prebuilt pages) and, for the Postgres store, `@kaynooo/pg-orm` are peer dependencies.

`kay add auth` does the rest of this section for a project with `server` and `tailwind`: it installs the packages, writes `src/auth.ts` (over the project's pg-orm `Database`, to which it adds `...authTables`, or over a SQLite file of its own; kayjs-mail's `mail.enqueue` as the mailer when `src/mail.ts` exists), a root `src/routes/_guard.ts` exporting `auth.guard()`, `KAY_SECRET` and `SITE_URL` in `.env.example`, and lists `authPages(...)` and kayjs-ui's `ui()` in kay.config.ts. The sign-in, register and account pages stay open to visitors. Delete the guard for a site with public pages.

```ts
// src/auth.ts
import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import { createAuth, discordProvider } from '@kaynooo/kayjs-auth'
import { authTables, pgStore } from '@kaynooo/kayjs-auth/pg'
import { Database } from '@kaynooo/pg-orm'
import { session } from 'kay/server'
import { mail } from './mail'
import { Posts } from './tables'

export const db = new Database({ url: process.env.DATABASE_URL!, tables: [...authTables, Posts] })

export const auth = createAuth({
  sessions: session<AuthSessionData & { cart: string[] }>(),
  store: pgStore(db),
  name: 'Example',
  signInPage: '/login',
  oauth: { discord: { provider: discordProvider(), clientId: process.env.DISCORD_CLIENT_ID!, clientSecret: process.env.DISCORD_CLIENT_SECRET! } },
  email: { mailer: { send: mail.enqueue }, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' } },
  roles: { admin: ['editor'], editor: [] },
})
```

```ts
// kay.config.ts
import { auth } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [auth({ module: './src/auth' })],
})
```



### Prebuilt pages

kayjs-auth ships every sign-in and account page as a kay extension, styled with kayjs-ui, in English and French. `auth()` in kay.config.ts, as in Setup, serves them, and `createAuth` sends users to them:

```ts
// src/auth.ts
export const auth = createAuth({ /* ... */ pages: true })
```

### The signed-in user

```kay
--- server
const user = await ctx.locals.auth.user()
---
if user as signedIn
  p Signed in as {signedIn.email}
else
  a(href="/login") Sign in
```

### Guards and gates

A `_guard.ts` default-exports kayjs-auth's guard:

```ts
import { auth } from '../../auth'

export default auth.guard({ redirect: '/login', require: 'editor' })
```

Plain Elysia routes, such as an API, close behind a gate, which uses the plugin itself:

```ts
const api = new Elysia({ prefix: '/api' })
  .use(auth.gate())
  .get('/me', ({ auth }) => auth.user())
  .get('/stats', () => stats(), { auth: 'admin' })
  .get('/health', () => 'ok', { auth: false })
```

## Reference

### Setup rules

That one line is the whole declaration. `module` is the file exporting `auth`, the `createAuth` result, as `export const auth`, relative to the project root, and the extension hands `pages()` its plugin, used before the pages: the app mounts nothing else and declares no `Register`, `kay check` typing `ctx.locals.auth` and checking links to kayjs-auth's routes off it. It loads as `pages()` builds the app, so kay.config.ts never loads the app's database, and `kay check`, the editor and `kay build` never load it. `auth()` also brings the prebuilt pages (see Prebuilt pages); an app keeping its own serves the plugin alone with `auth({ module: './src/auth', pages: false })`. `auth({ server })` takes any other plugin as a function, `server: async () => somePlugin`.

A plain Elysia app, or one mounting the plugin by hand, uses it before the pages, `new Elysia().use(auth.plugin).use(await pages())`, and registers `locals: LocalsOf<typeof auth.plugin>` and `app: typeof auth.plugin` (or its own Elysia instance) in kay's `Register` for `kay check`. The plugin may also sit inside a plugin of the app's own, at any depth: `auth` reaches every route declared after it. The session plugin then goes on the app itself, or is left to `auth.plugin`: used first inside that plugin, it stays there, and every route outside it answers 500 with an error saying so. The plugin uses the session plugin itself, puts `auth` in every request's context (`ctx.locals.auth` in pages, actions and guards, `({ auth })` in Elysia routes), and serves the OAuth routes. `db.sync()` creates kayjs-auth's tables with the app's. What it logs, a mailer, a hook or a check that failed, goes where the app's `log` setting sends kay's messages, headed `kayjs-auth:`, as text, as JSON or to the app's function, under the request being answered.

`createAuth` options:

- `sessions`: the plugin kay's `session()` returns, its data type including `AuthSessionData`: the signed-in state lives in the app's kay session, and kayjs-auth sets no cookie of its own.
- `secret`: left out, kayjs-auth derives its own key from the session's secret, which is kay's `KAY_SECRET` unless `session()` gets one ([The app secret](../../../llms/environment.md#the-app-secret); `sessions.deriveSecret('kayjs-auth')`, HKDF, so it says nothing of the session's key and a rotated list stays rotated), and one secret serves both. Pass one (at least 32 characters, from the environment, a list rotates) to keep a second secret for kayjs-auth; a session plugin that is not kay's `session()` needs it. Each use gets its own key derived from it: encrypting TOTP secrets and provider tokens, and digesting where a sign-in came from. The first writes, every one reads. With the default, TOTP secrets and stored provider tokens are sealed under a key derived from the session secret: keep the old session secrets in its list while such data exists, or set `secret` separately. Moving an app from `AUTH_SECRET` to the default needs `secret: [...sessions.deriveSecret('kayjs-auth'), process.env.AUTH_SECRET!]` for as long as data sealed under it exists. After a rotation each user gets one `new-sign-in` mail, since the digest of where they sign in from changes with the secret.
- `store`: see Stores.
- `site`: the site's public origin, for OAuth callbacks, mailed links and passkeys; it is kay's `site` (`site` in kay.config.ts, else `SITE_URL`) when left out, so the app sets it once, and only `site` of a plain Elysia app is its own. With OAuth or mail configured and no origin anywhere, the server refuses to start and a request answers 500, naming `SITE_URL`; `kay dev` supplies `http://localhost:<port>`, so development needs none. `name`: the site's name in mails and authenticator apps, the origin's host by default. `url` and a `site` that is a name are the old forms of both, kept until 1.73 (`deprecated-site-name`).
- `prefix`: where the OAuth routes live, `/auth` by default.
- `signInPage`: where a failed OAuth sign-in goes with `?error=`, `/` by default, and where `guard()` and `requireUser()` send an anonymous visitor opening a page when there are no `pages`. `failurePage`: where every failed OAuth sign-in goes instead, with no reason in the URL, so that whether an account may sign in does not leak through an `allow` list. `twoFactorPage`: where a sign-in goes to ask for the code, `/two-factor` by default. `pages`: see Prebuilt pages, which these then default to.
- `oauth`, `allow`, `onSignUp`, `profileFields`: see OAuth. The hooks take one event object, `onSignUp({ user, profile })`, `onDelete({ user })`; the positional shape is read until 1.73. `signUp`, `rules`: see Passwords. `email`: see Mailed links. `onDelete`: see Account. `onAuthEvent`: see Security mails. `roles`, `defaultRoles`, `authorize`: see Guards and gates. `scopes`: see Bearer tokens. `rateLimit`: see Limits. `captcha`, `breachedPasswords`: see Bots and breached passwords. `remember`, `sessionsPage`, `locate`: see Sessions. `passkeys`: see Passkeys. `audit`: see Events and the audit log. `admin`: see Admin. `organizations`: see Organizations. `oauthServer`: see OAuth server for MCP clients.

### Prebuilt pages rules

- `auth({ module, prefix, home })` and `createAuth({ pages: { prefix, home } })` take the same `prefix` and `home`, and `createAuth({ pages: true })` reads them off `auth()`, so give them once, in `kay.config.ts`. A `prefix` in both places must match, else the server stops at start naming both; `home` in `createAuth` wins when they differ, and the server logs a warning at start naming both. `prefix` is where the pages live, `/auth` by default, and `home` where a sign-in goes when nothing asked for another page and where a sign-out goes, `/` by default. `pages: true` takes the defaults. `home` is also where the mailed links, a code, registering, a passkey and a provider land when nothing asked for another page; the pages localize it for a site with locales.
- `pages.remember` is `'checkbox'` (default), `'always'` or `'never'`: the sign-in and register pages show a "keep me signed in" box, or none and every sign-in remembered (`'always'`) or none (`'never'`). Unchecked is the same by password, passkey, register, magic link, code and each provider; checked is `remember.maxAge` on all of them. The provider buttons and the passkey button read the first box of the page, which a click carries, so a browser without script signs in with a provider as unchecked. A magic link carries the choice of the browser that asked for it, so opened in another browser it signs in as chosen. A page of the app's own, or a link to `/auth/<provider>` with no `remember`, gets the session plugin's `maxAge`, and the sign-out and provider routes fall back to `home` as written, unlocalized: only the prebuilt pages localize it.
- The pages: `sign-in` (providers, password, magic link or code, passkey, remember me), `register`, `two-factor`, `reset-password`, `verify-email`, `magic-link`, `confirm-email`, and under `account`: the profile (address, username, verification), `security` (password, two-factor with its QR code and recovery codes, passkeys), `sessions`, `connections` (shown with providers), `tokens`, `clients` (the apps signed in by OAuth, with a revoke button; shown with the OAuth server) and `data` (download, asking for a recent proof first, and deletion). Each works without JavaScript but passkeys, and shows only what the config enables.
- With `pages`, `signInPage`, `twoFactorPage`, `sessionsPage` and every `email.links` default to those pages, and `auth.guard()` without `redirect` sends an anonymous GET or HEAD to the sign-in page (a browser fetch, or a request whose `Accept` names neither `text/html` nor `*/*`, gets the 401), `?redirect=` back, in the page's language (`/fr/page` goes to `/fr/auth/sign-in?redirect=%2Ffr%2Fpage`). Without `pages`, `email.links` names a page for each kind, or `createAuth` throws.
- An app file at a page's path replaces that page alone: `src/routes/auth/magic-link.kay` is the app's own magic-link page. Its texts live under `auth` in kay's messages: a key in the app's `src/messages/en.ts`, such as `auth: { signIn: { title: 'Welcome back' } }`, replaces that text and keeps the rest.
- The pages reached before signing in, `sign-in`, `register`, `two-factor`, `reset-password`, `verify-email`, `magic-link` and `confirm-email`, set `guards: false`, and the four that open from a mailed link (`reset-password`, `verify-email`, `magic-link`, `confirm-email`) send `Referrer-Policy: same-origin` so the token in the address never reaches another site: none of the app's guards above them runs there, whatever it checks. An app's root `_guard.ts` asking for a session, `export default auth.guard()`, keeps the rest of the site to signed-in users and still lets visitors sign in, the `account` pages keeping it; but a guard for maintenance, an IP allow-list or invite-only access skips those pages too. An app needing such a guard on one of them replaces that page with its own, which the app's guards cover unless it sets `guards: false`; an app page replacing one under a guard asking for a session sets it. kayjs-auth's own routes, OAuth and the rest, are its plugin's, which page guards never reach.
- A site with data of its own on its users keeps these pages: `createAuth({ pages: { profile } })` adds fields to the account page's profile form. `profile` is `{ fields, load, save }`: `fields` maps a name to `{ label, type?, autocomplete?, required?, maxLength? }` (`type` one of `'text'` (default), `'textarea'`, `'tel'`, `'url'`, `'email'`), `load(user)` answers what each field holds now, and `save(user, values)` stores the trimmed values (a throw answers 500), once `required` and `maxLength` (500 by default) passed, and may return `{ errors: { field: 'message' } }` to refuse. `label` is a string, or a map by locale (`{ en: 'Bio', fr: 'Biographie' }`) the page reads in its own locale, the first when none matches; `load` answering anything but a string, `null` or `undefined` for a field throws, and `save` throwing answers 500. `auth.profile(locale?)` and `auth.saveProfile(values)` are what the form calls, for a page of the app's own, `saveProfile` throwing without `pages.profile`: both need a session, a bearer token cannot edit a profile, and an admin acting as a user can.
- `captcha.widget`, `turnstileWidget(siteKey)` or `hcaptchaWidget(siteKey)`, is the widget the pages show where `captchaRequired` asks for one; with the proof of work they carry its field instead, and say JavaScript is needed to a browser without it.
- A provider's button reads its `label`, set on each preset (`GitHub`, `Google`) and overridden by `oauth.<name>.label`.
- kayjs-ui is a peer of kayjs-auth, so the pages render with the app's own copy; the app keeps `@iconify-json/tabler` and Tailwind, kayjs-ui's peers.
- kayjs-auth and kayjs-ui are released with kay at its version and peer on kay's minor: the app installs the ones matching its kay and moves them together.

`auth.features()` tells any page, prebuilt or the app's own, what the config enables: `{ providers: [{ name, label }], email, codes, signUp, requireVerified, passkeys, captcha, scopes, prefix, oauthServer, signInPage, pages }`, `captcha` being the widget, `'proof-of-work'` or null.

### Signed-in user rules

- `auth.user()` is a method returning a promise, `await` it. It answers `{ id, email, emailVerified, username, roles, hasPassword, twoFactor, locale, guest, data, providers }`, or `null`: `data` is what the `user` schema keeps (see OAuth), `{}` without one, and `providers` the id of each linked provider (`providers.discord?.id`), read for `user()`, `requireUser()` and the hooks (`onSignUp`, `profileFields`, `onDelete`, `exportData`, `admin`, `onAuthEvent`, `impersonator()`, `userFromToken`); guards, gates, `authorize`, admin lists and results such as `register` give a `BareUser` without it, and `bareUser()` is `user()` without it and without the read. Returning `await auth.user()` whole to the client sends provider ids. Secrets never leave the store: no hash, no TOTP secret, no token.
- It reads the session first, then the request's `Authorization: Bearer` token. `via()` says which: `'session'`, `'bearer'` or `null`.
- `requireUser()` is `user()` for a page or an action that needs one, with no guard above it: it answers the `User`, and for an anonymous request it stops as `auth.guard()` does, a visitor reading a page going to the sign-in page with `?redirect=` set to where they were, with `pages`, and any other request, an action's call included, refused with a 401. The user is read once per request however many of them ask.
- `requireUser({ redirect, scope })` names the sign-in page of an app without `pages` or `signInPage` (an empty `redirect`, as in `guard`, is the default), and a scope a bearer token limited to scopes needs, which is otherwise refused with a 403 as `guard()` refuses it. `signInUrl(back?)` is that sign-in URL for a link of the app's own: `a(href={ctx.locals.auth.signInUrl()}) Sign in` leads back to the page it is on, `signInUrl('/pricing')` to another path. A `back` that is not a path of this site, `//evil.example` or `https://...`, leads home instead.
- A sign-out button is a form posting to kayjs-auth's own route, with no action of the app: `form(method="post" action={`${ctx.locals.auth.features().prefix}/sign-out`})`, with an `input(type="hidden" name="redirect" value="/")` for where to go after, a path of the site, else the pages' `home` or `/`. It answers 303, only to a post: a link or a prefetch signs no one out, and a post from another site gets a 403.
- `signOut()` signs this session out under a new session id, keeping the rest of the app's session data, and takes it off the user's sessions, so a copy of the cookie is worth nothing either. `signOutEverywhere()` ends every session of the user, copied cookies included, and every bearer token they hold; `signOutEverywhere({ keepThisOne: true })` keeps this session, the tokens still ending.
- `signIn({ id })` signs a user in directly, without their second factor, for a way of signing in the app proves itself. kayjs-auth's own flows all go through the second factor.
- A deleted user, one signed out everywhere since, or a session ended or unseen past its lifetime, reads as `null`, and the stale entry leaves the session.
- A websocket route on an app using the plugin reads its user as `await ws.data.auth.user()`, off the cookie or token its upgrade carried. `auth.socketUser(ws)` does the same for a handler typed for any socket, `null` for an anonymous one or one opened without the plugin. A socket's user is read again once 30 seconds have passed since the last read, so a sign-out, "sign out everywhere", a revoked token or a ban reaches an open socket within 30 seconds of its next read: `ws.data.auth.user()` then answers `null`, and `socketUser` also closes the socket it had answered a user for, with code 1008. A handler reads the user on each message it acts on, not once on `open`.
- A browser's cross-site POST or websocket upgrade reads the session as signed out on a plain Elysia app too, which has no Origin check of kay's, and a session write from it (a sign-in, a sign-out) answers a 403: `Origin` (or `Sec-Fetch-Site`) must name the request's host, the host of `site`, so an app behind a proxy that does not pass `Host` on sets `site`. `socketUser` answers `null` and closes such a socket with 1008, and `ws.data.auth.user()` reads `null`. A request with neither header (a script, a webhook), a safe method, an `Authorization: Bearer` token, the OAuth `form_post` callback, and what an `api({ cors })` module of kay admits are left alone.

### Sessions

Each sign-in is kept on the user's list of sessions in the store, whatever holds the session itself, so one can be ended from another browser:

- `listSessions()` lists `{ id, current, device, userAgent, ip, place, createdAt, lastSeenAt }`, oldest first, `current` the browser asking. `device` is the user agent read as `{ browser, os, mobile }`, such as `Firefox` and `Windows`, `null` for what it does not know. `place` is what `locate(ip)` answers, an option of the app's over a geolocation database of its own, `null` without one or when it throws. A visit is recorded at most every five minutes, or at once from a new address.
- `revokeSession(id)` ends one of them, effective on that browser's next request; ending the current one signs out. It answers `{ ok: true }`, or `{ ok: false, error: 'not-found' }` when the user has no session with that id (`signed-out` through a bearer token). `endSession(id)`, answering a boolean, is its old name.
- The lifetimes are the `session()` plugin's own, read from it with nothing to repeat: a session unseen for its `maxAge` is over even when its cookie lives on, and one signed in its `absoluteMaxAge` ago is over however often it was seen, "remember me" included. The cookie and the list agree, as both follow the plugin. Only `remember.maxAge` is kayjs-auth's, a duration (seconds or `'90d'`), 90 days by default.
- "Remember me": `remember: true` keeps the session `remember.maxAge` unseen; `remember: false` gives it a cookie the browser drops on closing, over after the plugin's `browserMaxAge` unseen. Without `remember` the session takes the plugin's `maxAge`, whatever a sign-in before chose in that browser. It goes in the trailing options object of `signInWithPassword(input, { remember })`, `register(input, { remember })`, `requestMagicLink(email, { remember })` (for the link opened, or the code typed, in that browser), `signInWithPasskey(response, { remember })` and `signIn(user, { remember })`, or as `?remember=1` or `?remember=0` on an OAuth link, and holds through the second factor.
- A change to how the account is signed in to ends the user's other sessions, which leave the list, and every bearer token, this browser staying signed in: a password changed or reset, the second factor turned on or off, new recovery codes, a passkey removed, a provider unlinked, a new address confirmed. So does `signOutEverywhere`.
- Through a bearer token, `listSessions()` is empty and `revokeSession` ends nothing: the list belongs to the browsers.
- `sessionsPage`, such as `/account/sessions`, is where the app lists them: `new-sign-in` mails link to it, so a user who does not know the sign-in can end it.
- A sign-in from before the list existed goes on it at its next request.
- Every sign-in of a person (a guest excepted) sets the readable cookie `kay_user`, `Path=/`, `SameSite=Lax`, `Secure` exactly when the session cookie is, a new random value each time, `Max-Age` as long as the session can last (`absoluteMaxAge`) and a session cookie for `remember: false`; a sign-out, or a session found over, clears it. It is a hint for a script of the site, never read by the server and never a permission: kayjs-cms's script asks its guard when it sees it, so an editor sees the Edit this page link at once. Set on the response of the sign-in or sign-out, a route's own `Response` included.

### Guard and gate rules

- An anonymous GET or HEAD that may be a page opening goes to `redirect`, with where they were going as `?redirect=`, a path to hand to `signInWithPassword` or an OAuth link. Without `redirect`, the pages' sign-in page or the `signInPage` of `createAuth` is used; without any, and for any post, the answer is a 401. A user who does not meet `require` gets a 403.
- A requirement is a role, a predicate `(user, ctx) => boolean`, or a list of which any one passes. A role includes the roles `roles` lists under it: with `{ admin: ['editor'], editor: [] }`, an admin meets `'editor'`. A user's roles are `UserRecord.roles` in the store. `defaultRoles: ['user']` gives every new user those roles, by password or by provider; a store leaves them to kayjs-auth rather than filling them in itself, so it knows which roles were given on purpose.
- `auth.hasRole('admin')` is the predicate form, `auth.isGranted('admin', user)` the plain check.
- The pieces `createAuth` builds these from are exported for an app with its own principal: `createRoleHierarchy(hierarchy, user => user.roles)` gives `{ isGranted, hasRole }`, `createGate({ principal, authorize, defaultRequirement, scopes?, defaultScope? })` is the Elysia plugin behind `auth.gate()`, and `scopeAllows(tokenScopes, wanted)` says whether a bearer token's scopes meet a route's `scope:`, true for a session (`null`) and `false` as `wanted`. The types of a requirement are `Requirement<User, Grant>` (a grant, `{ type, resourceId }`, a `Predicate<User>` or a list), `Predicate`, `PolicyContext` (the `params`, `body` and `query` a predicate may read), `Principal`, `Level` and `RoleHierarchy`.
- `authorize: (user, requirement, level, ctx) => Promise<boolean>` replaces the decision, for grants on single records: `decide(grantStore, user, requirement, level, ctx)` reads a `GrantStore` of the app's. `level` is `'read'` for GET and HEAD, `'write'` otherwise.

- Every route the instance declares after `.use(auth.gate())` needs a signed-in user, or `gate({ require })`'s requirement. A route asks for more with `auth: <requirement>` and stays open with `auth: false`. Routes added through `group`, `guard`, `route`, `all`, `ws` or a used plugin are closed too, so a route that forgets `auth:` stays closed. A route declared before the gate stays open: use the gate first.
- `auth.gate()` brings `auth.plugin` along, so `auth` reaches the routes declared after the gate's instance too.
- Gates nest: a sub-router behind `auth.gate({ require: 'admin' })` inside an app behind `auth.gate()` needs both. A route's `auth:` and `scope:` change only the gate nearest it, so `auth: false` or a looser requirement in the sub-router still meets every gate around it.
- 401 to an anonymous caller, 403 to a signed-in one who is denied. A bearer token passes as its user.
