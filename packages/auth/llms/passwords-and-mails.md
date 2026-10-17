# kayjs-auth: Passwords, guests, mailed links and security mails

## Passwords

```kay
--- server
import { s } from 'kay'

export const signIn = action(s.Object({ identifier: s.String({ maxLength: 254 }), password: s.String() }), async (input, ctx) => {
  const result = await ctx.locals.auth.signInWithPassword(input, { redirect: ctx.url.searchParams.get('redirect') ?? '/' })

  if (!result.ok)
    return ctx.fail(400, { error: result.error })

  return ctx.redirect(result.redirect)
})

const failure = ctx.failed(signIn)
---
form(action={signIn})
  input(name="identifier" autocomplete="username")
  input(name="password" type="password" autocomplete="current-password")
  button Sign in
if failure?.data?.error === 'invalid'
  p.error Wrong email or password
```

- `register({ email, password, username?, locale? })` answers `{ ok: true, user, signedIn: true }` once signed in, `{ ok: true, signedIn: false }` when the app requires verified addresses (`requireVerified`, on by default with a mailer), or `errors` by field (`email`: `'invalid'`, or `'taken'` with `requireVerified: false` or no mailer; `password`: `'too-short'` or `'too-long'`; `username`: `'length'`, `'characters'`, `'mixed-scripts'` or `'taken'`), or `error: 'limited'`, `'captcha'` or `'closed'`. `'mixed-scripts'` (and `'invalid'` for an address before its `@`) catches a name mixing Latin, Cyrillic and Greek letters only: a name written wholly in Cyrillic that looks Latin passes, so show names next to something they cannot fake, such as an avatar. It signs the user in unless the app requires verified addresses, and mails a verification link when the app sends mail.
- Every way of signing in takes one trailing options object, `{ redirect, remember, captcha }`, with the ones it uses: `register(input, { remember, captcha })`, `signInWithPassword(input, { redirect, remember, captcha })`, `requestMagicLink(email, { redirect, remember, captcha })` and `signInWithPasskey(response, { redirect, remember })`. Before 1.52 `signInWithPassword` and `register` took them in the input, and `requestMagicLink` and `signInWithPasskey` took a positional `redirect`: those still work for now and log a warning, with the options object winning when both are given, and `kay check` reports them as `deprecated-sign-in-options`. A `redirect` that is not a path of the site leads home either way.
- `signInWithPassword({ identifier, password }, { redirect?, remember?, captcha? })` takes an email, or a username when it holds no `@`. A wrong password and an unknown account answer alike, `'invalid'`, in the same time. `'unverified'` comes once the password is right, under `email.requireVerified`, the default with a mailer: the page then offers `sendVerification()`, which this browser may call from then on. `'limited'` past the attempts allowed: six tries at one account in 15 minutes hold it until the window ends, the right password included, a lockout anyone who knows the address can cause. The tries count against the account, its email and every spelling of its name alike, and each is counted before its password is checked, so parallel guesses do not slip past; a right password clears the count.
- `signUp: false` in `createAuth` keeps visitors from making their own accounts, for a site whose users the app makes: `register` and `signInAsGuest` answer `'closed'`, an OAuth sign-in with a provider account no user has linked comes back `?error=refused` as one `allow` refuses does, and a linked one still signs in. `features().signUp` says so; the prebuilt sign-in page drops its link to `register`, which answers 404.
- `auth.createUser({ email?, username?, password?, roles?, emailVerified?, locale? })` makes a user from server code, a script or an admin page, `signUp: false` or not: checked as `register` is, with its `errors` by field, `roles` given beside `defaultRoles` (a role the `roles` option does not declare throws), `onSignUp` run, no one signed in and no mail sent. The address counts as unverified unless `emailVerified: true`: with `requireVerified`, on by default with a mailer, such a user cannot sign in with their password until they verify it. An address any account holds answers `taken`, even an unverified one `register` would replace. It throws without an email or a username to sign in with. It answers `{ ok: true, user }`.
- Passwords are hashed with argon2id; a hash made weaker, or by bcrypt in an older app, is rehashed on the next sign-in.
- The rules are browser-safe, so an island refuses before posting: `passwordProblem`, `emailProblem`, `usernameProblem`, `normalizeEmail` and `normalizeUsername` from `@kaynooo/kayjs-auth/rules`. Passwords are 10 to 128 characters and usernames 2 to 32 unless the `rules` option says otherwise: `rules: { password: { min: 12, max: 64, check: p => /\d/.test(p) ? undefined : 'Add a digit.' }, username: { min: 3, max: 16 } }`. `check` returns a problem code or a message, which `register`, `resetPassword`, `changePassword` and `createUser` answer as `errors.password` and the prebuilt pages show as it is. The server, the pages' hints and `minlength` follow the rules, and `features().rules` hands `{ password: { min, max }, username: { min, max } }` to a page or an island, which passes it, or the `rules` object itself, as the second argument: `passwordProblem(value, features.rules)`, `usernameProblem(name, rules)`. A password longer than a ceiling lowered later can still sign in. Emails and usernames are stored NFKC-folded, emails lowercased, usernames compared without case, and a name or an email's local part mixing Latin with Cyrillic or Greek is refused.

## Guests

- `signInAsGuest({ captcha? })` signs the browser in as a new user with `guest: true`, no email and no password, so the app keeps their cart or their drafts before they sign up; `onSignUp` runs for them then. It is counted as registering is and CAPTCHA-checked as `'guest'`, answers the guest signed in already as is, and `{ ok: false, error: 'signed-in' }` to anyone else.
- `register(...)` from a guest's browser makes the guest that account, keeping their id and so the app's data; it stays signed in even with `requireVerified`, and `onSignUp` does not run again. A guest registering an address another account holds stays a guest, `{ ok: true, signedIn: false }`, so a guest's browser can tell a held address from a free one, at the 6 registrations an hour `register` allows a client. An OAuth sign-in with a provider account no user has does the same; one a user has already signs in as that user, leaving the guest behind.
- A guest's way back in is their session: once it ends, the guest is left in the store, `listUsers` showing them with `guest: true`, until `guests: { maxAge: '30d' }` (a Duration) deletes a guest older than that who holds no session, calling `onDelete` as for any user. Without `guests` they are kept for good. The store prunes at most once an hour, up to 10,000 guests a run, and a guest whose `onDelete` throws stays for the next run. A custom store lists them with `users.staleGuests(createdBefore, limit)`; without it guests are kept.

## Mailed links

```ts
email: {
  mailer: { send: mail.enqueue },
  links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' },
  templates: { 'magic-link': ({ site, url }) => ({ subject: `Your ${site} link`, text: url!, html: `<a href="${url}">Sign in</a>` }) },
}
```

- `mailer.send(mail)` gets `{ to, kind, site, locale, subject, text, html, url?, code?, detail? }`, filled from the templates keyed by `kind`, its result ignored. The mails a visitor asks for without being signed in, verification, reset, magic link and `account-exists`, leave off the response's path, a failure logged, so the time taken tells nothing of which addresses exist; the others are awaited. Kinds are the link types, the security events, `invitation` and `account-exists`. An app with its own templating reads `kind`, `locale`, `url` and `code`, with `site`, the site's name, and `detail`, the organization an invitation is to or the provider, passkey, token or new address an event is about.
- Mails are written in the user's language: `locale` on the user, a BCP 47 tag kept from the browser's `Accept-Language` on signing up, from `register({ locale })`, or set with `setLocale(tag)`; the browser's when the user has none. `email.locales` lists the languages the site writes, `['en']` by default, the first for anyone else: a tag picks its own, else one of its language (`fr-CA` gets `fr`). kayjs-auth writes English (`defaultTemplates`) and French (`frenchTemplates`); `templates` goes over them in every language, and `translations: { de: {...} }` over both for its own.
- With `@kaynooo/kayjs-mail`, `mailer: authMailer(mail.enqueue)` renders each mail through its components and its own wording, which the app overrides line by line in its messages or replaces with its own view per kind, themed by the app's mail settings and in the mail's language, and leaves it to its queue, which retries a mail server that is away; `authMailer(mail.send)` sends it at once, before the call answers for the mails kayjs-auth awaits. Its llms.txt shows the setup. A mailer of it also fits as it is, `{ send: mail.enqueue }`, sending kayjs-auth's own html. In development and tests the mails go to its outbox, listed at `/_kay/mail`.
- `links` names the app's page for each kind, the prebuilt pages' by default with `pages`; the link is `url` + that path + `?token=`. The page shows a button posting the token to an action, so opening the link spends nothing:

```kay
--- server
import { s } from 'kay'

export const query = s.Object({ token: s.Optional(s.String()) })

export const spend = action(s.Object({ token: s.String() }), async ({ token }, ctx) => {
  const result = await ctx.locals.auth.signInWithMagicLink(token)

  if (!result.ok)
    return ctx.fail(400, { error: result.error })

  return ctx.redirect(result.redirect)
})

const failure = ctx.failed(spend)
---
form(action={spend})
  input(type="hidden" name="token" value={ctx.query.token ?? ''})
  button Sign in
if failure
  p.error This link has expired or was already used
```

- `requestMagicLink(email, { redirect?, remember?, captcha? })` and `requestPasswordReset(email)` answer alike whether or not an account has that address: counted per address either way, and mailed off the response's path, so neither the answer nor its time tells which addresses exist. They answer `{ ok: true }`, `'limited'` past the mails allowed, `'captcha'` (see Bots and breached passwords), or `'unavailable'` without a mailer. `signInWithMagicLink(token)` signs in, to where the link was asked for, and verifies the address.
- `resetPassword(token, password)` sets the password (`errors.password` as `register`'s, `'breached'` included), verifies the address, ends every other session and bearer token, voids the other mailed links and signs in. A refused password leaves the link usable.
- `sendVerification()` mails the signed-in user a new link or, with nobody signed in, the account this browser last registered or proved the password of with an `'unverified'` answer, until it signs out; a browser that registered an address another account holds gets `{ ok: true }` too, mailing no one, counted alike. `'signed-out'` otherwise, as for a browser whose registered account was replaced by a later registration. Mailing the signed-in user is awaited, a failing mailer failing the call; the others leave off the response's path. `verifyEmail(token, password?)` verifies the address and never signs in: whoever opens the mail may be confirming an account a stranger registered with their address. It verifies in the browser signed in as the account, that registered it, or that proved its password with an `'unverified'` answer; elsewhere it takes the account's password, and answers `{ ok: false, error: 'confirm' }` to ask for it, the link still usable (`'limited'` past the sign-in tries, which it shares). It answers `/` as where to go when this session is the user's, `signInPage` otherwise.
- A magic link or a reset that proves an address for the first time hands the account over clean: whatever was set on it before, perhaps by someone who registered the address first, is dropped (the password, the second factor and its recovery codes, passkeys, linked providers, bearer tokens), and every other session ends. A user who registered with a password and never verified the address loses that password this way, and sets another.
- `changeEmail(proof, email)` mails a link to the new address (`errors.email` `'invalid'`, `'taken'` or `'unchanged'` otherwise); `confirmEmailChange(token)` moves the account to it, ends its other sessions and bearer tokens and warns the address it left, when that one was verified.
- `codes: 'code'` (or `'both'`, or per kind: `{ 'magic-link': 'both' }`) makes magic link and verification mails carry a six-digit code instead of the link, or beside it. A link opened on another device, or in a mail app's own browser, signs in there; a code is typed where it was asked for, and works in that browser's session only. `requestMagicLink`, `register` and `sendVerification` park the code in the session, whether or not an account has the address. `emailCodePending()` answers `{ type: 'sign-in' | 'verify', email }` or null, for the page to show the code field. `signInWithEmailCode(code)` signs in to where the link was asked for, verifying the address as a magic link does; `verifyEmailCode(code)` verifies the address. Both answer `{ ok: true, redirect }`, or `'invalid'`, `'expired'` (no code waiting in this session, past its 10 minutes, or killed after five misses) or `'limited'` (`emailCode` 30 per client and `emailCodeAccount` 10 per address per 15 minutes). Spaces and dashes in the code are ignored. A code works once, even when two requests spend it together; spending the code spends the link of the same mail, and the other way round. Codes are stored as keyed digests, bound to the session's nonce. The mail's `code` field holds it, and templates get it as `code` beside `url`, either one missing when the mail does not carry it.
- A link works once, even when two requests spend it together: verification for 24 hours, a reset and an email change for one hour, a magic link for 15 minutes, a code for 10 minutes, unless `email.expires` sets them: `expires: { 'verify-email': '7d', 'magic-link': '30m' }` takes a `Duration` for each of `verify-email`, `reset-password`, `magic-link`, `change-email`, `sign-in-code` and `verify-code`. The built-in mails state the real figure in the reader's language (`7 days`, `2 heures`), and a template gets the seconds as `expires: { link?, code? }` beside `url` and `code`; `lifetime(seconds, locale)` words them. A new link of a kind voids the last one, a link to an address the account has since left opens nothing, and links are stored as digests only. A spent or unknown link answers `'invalid'`.
- `requireVerified`, on by default once `email` is set, refuses password sign-in until the address is verified and signs no one in on registering. Registering then answers alike whether or not the address has an account, `{ ok: true, signedIn: false }` after the same work, the session left the same, and the holder of a taken address gets an `account-exists` mail, linking to `signInPage`, at most 3 an hour, instead of the verification link: neither the answer nor its time tells which addresses exist, but for the app's own `onSignUp` and `onDelete`, which run on a free address only, and a username: an unverified holder's own name is free with its address, so registering it with that name tells it is pending. `requireVerified: false` lets an unverified address sign in, registering signing in at once, and so brings back `'taken'` for a held address, which tells anyone which addresses have an account. A registration refused for a field leaves whatever account holds the address as it was. An address registered and never verified can be registered again, so no one squats an address they do not own; an account with a role beyond `defaultRoles` or a linked provider is never replaced this way, while an invited one holding only default roles counts as unclaimed: give it another role, or verify its address.

## Security mails

A change to what protects an account is mailed to its verified address, never an unverified one, and handed to `onEvent` (see Events and the audit log). A mailer or an `onEvent` that throws is logged, never turned into a failed sign-in:

- `new-sign-in`: a device or network the account had not used before; the first sign-in has nothing to compare against. The mail links to `sessionsPage` when the app has one.
- `password-changed`, `two-factor-enabled`, `two-factor-disabled`, `recovery-code-used`, `recovery-codes-regenerated`, `account-deleted`.
- `signed-out-everywhere`, from `signOutEverywhere` and the sessions page's button, `detail` `this-one-kept` when the session asking stayed signed in.
- `email-changed`, mailed to the address left, `detail` the new one.
- `provider-linked` and `provider-unlinked`, `detail` the provider; `passkey-added` and `passkey-removed`, `detail` its name; `token-created`, `detail` its label.
