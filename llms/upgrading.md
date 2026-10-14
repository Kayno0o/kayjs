# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.44.0

### kayjs-auth asks for a proof of work by default

- `captcha` in `createAuth` defaults to `proofOfWork()`: registering, password resets and magic links ask for one, and a password sign-in from the third attempt. The prebuilt pages carry its field; `captcha: false` keeps the old behaviour.
- An app's own register, reset or magic-link form carries the field, `input(type="hidden" name="captcha" data-kay-work={challenge})` with `const challenge = await ctx.locals.auth.captchaChallenge('register')` (`'reset'`, `'magic-link'`, `'sign-in'`) in its server fence, and its action passes `captcha` on, else the request answers `{ ok: false, error: 'captcha' }`. The full form is in kayjs-auth's llms.txt under "Bots and breached passwords".
- A test posting such a form submits from the page it visited, `site.submit(register, fields, { from: await site.visit('/register') })`, which solves the field.
- `signInAsGuest` is CAPTCHA-checked as `'guest'`, with its own `captcha.on.guest`, where it was `'register'` before: a custom `captcha.verify(token, action)` matching on `action` handles it.

### kayjs-auth refuses cross-site requests on a plain Elysia app

- On a plain Elysia app mounting `auth.plugin`, a browser's cross-site POST or websocket upgrade reads the session as signed out, and its sign-in, sign-out or any other session write answers a 403. A kay app's actions and API refused these already, and an `api({ cors })` module still lets in the origins it names.
- Behind a proxy that does not pass the browser's `Host` on, set `url` in `createAuth` to the site's public address, whose host then counts as the request's own; without it, every form post touching the session answers a 403.
- Only an `Authorization: Bearer` header skips the check: a request with Basic credentials, which a browser sends on its own, is checked like any other.
