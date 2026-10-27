# kayjs-auth: Bots, breached passwords, limits, stores, testing and the dev tool

## Common tasks

### Bots and breached passwords

A CAPTCHA and the breached-password check are options of `createAuth`:

```ts
import { createAuth, turnstile, turnstileWidget } from '@kaynooo/kayjs-auth'

createAuth({
  // ...
  captcha: { verify: turnstile(process.env.TURNSTILE_SECRET!), widget: turnstileWidget(process.env.TURNSTILE_SITE_KEY!), on: { 'sign-in': 3, 'reset': 'always' } },
  breachedPasswords: true,
})
```

### Testing

kay's `testSite` builds the site as `pages()` does, the plugin mounted by the extension before the pages, so a test signs in through the site's own forms and stays signed in. An app mounting the plugin by hand passes it as `testSite({ use: [auth.plugin] })`.

```ts
import { testSite } from 'kay/test'
import { signIn } from '../src/routes/login.kay'

const site = await testSite()
const page = await site.submit(signIn, { identifier: 'ada@example.com', password: 'correct horse battery' }, { from: '/login' })
```

### Sign a test site in

A test site signs in with one call, no form round trip. `authTest(site)` from `@kaynooo/kayjs-auth/test` is the auth that site's `testSite()` built (each site its own, so call it after `testSite()`), and `kay generate resource` writes its test with it:

```ts
import { authTest } from '@kaynooo/kayjs-auth/test'

const as = authTest(site)

await as.signInAs({ email: 'ada@example.com', username: 'Ada', emailVerified: true })
expect((await site.visit('/auth/account')).status).toBe(200)
as.signOut()
expect((await site.visit('/auth/account')).url).toBe('/auth/sign-in?redirect=%2Fauth%2Faccount')
```

`signInAs` makes the member when no user has that email or username (`createUser`'s fields: `email`, `username`, `password`, `roles`, `emailVerified`, `locale`, and `data` for the fields of the app's `user` schema), signs an existing one in as they are (it throws when the email, username or data given differ from theirs, or a role given is one they lack), sets the session cookie in the site's cookie jar and returns the user. A second call switches member and `signOut()` makes the site anonymous again, its other cookies kept. It goes through the store, so it works on `pgStore` as on `memoryAuthStore`.

`await as.enrollTotp(user.id)` turns two-factor on for a member as the app would, so a password sign-in asks for a code: it answers `{ secret, code(offset?), recoveryCodes }`, the code of the current step and the recovery codes usable at the next sign-in. It throws for a missing member or one who has two-factor already, so a test never writes the user row's `totpEnabledAt`.

An app with a `src/auth.ts` module calls the same on its `auth` with the site first: `await auth.signInAs(site, { email })`, `auth.signOut(site)`, `await auth.sessionCookie(userId)`, `await auth.enrollTotp(userId)`; `auth.test(site)` names the site once, as `authTest` does.

## Reference

### Bots and breached passwords rules

- `captcha` is kay's proof of work unless set, `proofOfWork()`: no third party, no widget and no cookie, the browser hashing for some tens of milliseconds before the request goes through. It costs a bot CPU on each request rather than proving a human, so a site bots target anyway, or whose accounts are worth money to a spammer, sets Turnstile or hCaptcha instead. `captcha: false` turns it off.
- `proofOfWork({ difficulty, maxAge, store, on })`: `difficulty` is 100,000 by default, doubled with each request past the threshold up to 16 times, `maxAge` an hour; `store` keeps the solutions already used, this process's memory by default, `sqliteRates(path)` from `kay/server` sharing them between processes; `on` asks registering, resets and magic links always, a password sign-in from the third attempt, and a guest sign-in never.
- `await auth.captchaChallenge(action)` is the challenge for this client's next request, null when none is needed or the CAPTCHA is a third party's. A form carries it as `input(type="hidden" name="captcha" data-kay-work={challenge})`, kay's script posts its solution as the field's value, and the action passes it on as the token below; the prebuilt pages do, naming the field `kayjs-captcha`. `kay check` reports a call of `register`, `requestPasswordReset`, `requestMagicLink` or `signInWithPassword` on an `auth` with no `captcha` option (`missing-captcha`), as it answers `{ ok: false, error: 'captcha' }` until the form carries the field and the call passes it on.
- A browser without JavaScript posts the field empty, refused as `'captcha'`, and so does a form kay's script leaves to the browser (`navigation: false` with no island, `data-reload`, a `target`); the prebuilt pages then say JavaScript is needed, and that a stale solution should be sent again, and set a honeypot and a two-second `minTime` on their forms for the requests a post without JavaScript still reaches.
- The app's own register, reset and magic-link forms carry the field, or the app sets `captcha: false`. A client kay's script does not run in, a plain Elysia app's own pages, a mobile app or a SPA calling the API, has no solver: it sets `captcha: false` or a third party's check. A test calling `auth.register()` directly passes `captcha: false` to the auth it builds. A custom `verify` is given `'guest'` for `signInAsGuest`. A test posts from the page it visited, `site.submit(register, fields, { from: await site.visit('/register') })`, which `site.submit` solves the field of.
- `turnstile(secret)` and `hcaptcha(secret)` send the provider's siteverify only the secret and the token, from the server. The widget runs in the visitor's browser, which loads the provider's script (`challenges.cloudflare.com`, `js.hcaptcha.com`) and talks to it directly, so the provider receives the visitor's address, browser and cookies: say so in the site's privacy notice and consent flow. kay's proof of work calls no third party.
- `captcha.verify(token, action, { hostname })` checks the token the page's widget posted, `hostname` being the site's own from `site`, for `action` one of `'register'`, `'guest'`, `'sign-in'`, `'reset'` and `'magic-link'`. `turnstile(secret)` and `hcaptcha(secret)` are presets calling the provider's siteverify; their widgets post the token as `cf-turnstile-response` and `h-captcha-response`, which the action passes on. The presets refuse a token the provider says was made for another hostname, and Turnstile one made for another action (the prebuilt pages' widgets set `data-action`; a widget with none passes). The documented test secrets of both providers skip these two checks, as their answers name a hostname and action of their own.
- The token goes in the trailing `captcha` option of `register`, `signInWithPassword`, `requestPasswordReset` and `requestMagicLink`. A missing or refused token, or a `verify` that throws, answers `{ ok: false, error: 'captcha' }`, still counted against the client's limit.
- `captcha.on` sets each request to `'always'` (every one, by default for a third party's check, a guest sign-in as registering), `false`, or a number: asked only once this client made that many of it in the limit's window, so people rarely see it. `auth.captchaRequired(action)` says whether the next one needs it, for the page to show the widget. `captcha.widget` names that widget for the prebuilt pages and `features()`.
- `breachedPasswords: true` refuses a new password Have I Been Pwned lists, on `register`, `resetPassword` and `changePassword`, as `errors.password: 'breached'`. Only the first five characters of the password's SHA-1 leave the server, the answer padded with decoys. A function `(password) => boolean` checks against a list of the app's own instead. A check that fails or takes over three seconds lets the password through, logged: an outage never stops anyone registering. `pwnedPassword(password)` is exported for a check of the app's own.

### Limits

Attempts are counted in the store, so every process shares them, per client address (kept as a keyed digest, never the address; read as kay's `rateLimit` reads it, through `proxy` in kay.config.ts) and per account. A plain Elysia app that kay's `pages()` does not serve passes the same setting to `createAuth` as `proxy`, `{ hops: 1 }` behind nginx, or every client counts as the proxy. `rateLimit` overrides any of `DEFAULT_LIMITS`, each `{ max, window }` with `window` a string such as `'1h'`:

- `signIn` 40 per client and 15 minutes. Wrong passwords count against an account twice, a success clearing the client's hard stop only: `signInAccount` 6 per account and client, the hard stop (so a stranger's failures never lock the holder out from another address), and `signInAccountAll` 60 per account from every client, the ceiling, spent by wrong passwords alone and not given back by the holder's sign-in. Past the ceiling every sign-in answers `'limited'` until the window ends, and the first one mails the holder's verified address (`sign-in-locked`, also an event), at most once a day however often the ceiling is reached again. The same counts guard `verifyEmail(token, password)`. Behind one proxy without `proxy` set, every client shares the hard stop. Passkeys and the second factor have their own limits.
- `register` 6 per hour.
- `resend`, `forgot` and `magicLink` 12 per client and 3 per account per hour (`resendAccount`, `forgotAccount` and `magicLinkAccount`, the last two counted per address); `emailChange` 12 and `emailChangeAccount` 5.
- `invite` 30 per manager per hour, `inviteAddress` 5 per invited address per day.
- `organization` 10 per account per day, for `createOrganization`.
- `export` 6 per account per hour, for `exportData()` and `GET <prefix>/export`.
- `twoFactor` 30 and `twoFactorAccount` 8 per 15 minutes, for signing in and for turning the factor on; the first sign-in guess past `twoFactorAccount` mails the holder the `sign-in-locked` notice, at most once a day; `reprove` 6 per 15 minutes; `link` 40 per hour; `emailCode` 30 per client and `emailCodeAccount` 10 per address per 15 minutes.

### Stores

- `memoryAuthStore()` keeps everything in the process: for tests, and for trying kayjs-auth before a database is wired.
- `pgStore(db)` from `@kaynooo/kayjs-auth/pg` keeps it in Postgres through pg-orm, or in a SQLite file when the `Database` opens a `sqlite://` URL (`new Database({ url: 'sqlite://data/auth.db', tables: [...authTables] })`, opened in WAL mode with foreign keys on, waiting up to 5 seconds on another process writing), once `authTables` are among its tables, all named `kay_*`: `users`, `identities`, `tokens`, `recovery_codes`, `bearer_tokens` (with `oauth_client`, `oauth_family` and `oauth_resource` columns), `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_refresh_tokens`, `auth_sessions`, `passkeys`, `audits`, `organizations`, `members`, `invitations` and `attempts`. What belongs to a user, the audit log and their invitations aside, is deleted with them, and members and invitations with their organization.
- Any object with the `AuthStore` methods is a store: `users` (keeping `UserRecord.data`, the app's JSON from the `user` option, as given; `pgStore` adds its `data` column on `db.sync()`), `identities`, `tokens`, `recoveryCodes`, `bearerTokens`, `sessions`, `passkeys` and `attempts`, plus `oauth` (`clients`, `grants`, `codes`, `refresh`) for the OAuth server, `audit` for the `audit` option and `organizations`, `members` and `invitations` for the `organizations` option, each method sync or async. One verb per operation: `create` adds a row, `delete` removes one (answering whether there was a row, except a user's or an identity's, which cascades and answers nothing), `upsert` creates or replaces, `consume` deletes a row and answers it, or whether it had it, once only, and `use` marks an OAuth code or refresh token spent and keeps it, to tell a reuse. What must hold is written on each method: emails are looked up exactly, usernames without case; a mailed token, a recovery code and a TOTP step are spent once even by two requests together; deleting a user deletes what kayjs-auth keeps for them; `audit.list` orders by `at` then `id`, both descending, and takes `before` as a `Date` or an entry's `{ at, id }`; `audit.forget` strips a user from the log; `users.list` pages newest first and searches emails and usernames without case. Optional methods save queries and a store without them still works: `users.getMany`, `organizations.getMany`, `identities.deleteForUser`, `bearerTokens.deleteForUser`, `bearerTokens.findByDigestWithUser` (a token and its user in one read) and `prune(limits)`, which kayjs-auth starts at most once an hour from a request without making it wait, and the built-in stores use to delete expired links, codes, invitations and sessions (past their lifetime unseen, or the session plugin's `absoluteMaxAge` old), ended attempt windows, and bearer tokens expired for more than 30 days. A store without `prune` keeps those rows, with the IP and browser of a session and the address of a link, until the app deletes them. Attempt counts key an address by a keyed digest, never the address itself.
- A store over an app's own tables: `users.create(user)` answers the user as stored when the store picks its own id, such as a serial column's, `user` whole with only its `id` changed, and kayjs-auth goes on with it (ids are strings, so the store converts); answering nothing keeps the id kayjs-auth picked. TOTP secrets are stored sealed with the auth `secret`: a store whose rows hold plain base32 secrets from before seals each on read with `sealTotpSecret(secret, userId, plain)`, from `@kaynooo/kayjs-auth`, `secret` being the value `createAuth` takes, a list included. A plain base32 value matches `/^[A-Z2-7]+=*$/`, which a sealed one in practice never does, and what kayjs-auth writes afterwards is sealed already.

### Testing rules

The prebuilt pages' actions import as `@kaynooo/kayjs-auth/pages/<page>.kay`, such as `import { password } from '@kaynooo/kayjs-auth/pages/sign-in.kay'` and `import { changeUsername } from '@kaynooo/kayjs-auth/pages/account/index.kay'`, and a test submits them as it does its own; the sign-out button, a post to `/auth/sign-out`, a test makes with `site.fetch('/auth/sign-out', { method: 'POST' })`. `kay check` types such a module's named exports as the file declares them, so the test imports an action without a cast (`examples/noticeboard/tests/pages.ts` re-exports them).

A test needing a signed-in request without a form takes `await auth.sessionCookie(userId)`, the `Cookie` header of a new session signed in as that user, against the app's own auth, to send by hand: `app.handle(new Request(url, { headers: { cookie } }))`. It mints the cookie a request with no `x-forwarded-proto` reads, `__Host-kay_session` in production when kay.config.ts `site` is https, else `kay_session` (a request over https reads `__Host-kay_session` alone). `{ secure: true }` asks for `__Host-kay_session` and `{ secure: false }` for `kay_session`, as for a request sent over https in a test, or a site with no `site` behind a proxy sending `x-forwarded-proto: https`. It may be minted before the first `testSite()`: a cookie holding its session reads as signed in under the store the site brings.

Each `testSite` keeps its own cookies, one browser each. `memoryAuthStore()` keeps each test's users apart, and a mailer pushing into an array hands the test the links it would have mailed, `url` included; with kayjs-mail, its `outbox` holds what was sent.

### Dev tool

- Under `kay dev`, the dev tool every dev page carries has an Auth tab, brought by `auth()` with nothing to add in the app: the session's user (id, email, roles, how they signed in, password, two-factor) with a Sign out button that posts to the pages' `/auth/sign-out`. It reads `/_kay/auth`, a route mounted under `kay dev` alone.
