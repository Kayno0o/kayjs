---
title: Upgrading
order: 11
description: What each minor release breaks, and what to change in your app.
---
A minor release of kay can break your app. This page lists each one that does, with what to change. A patch never breaks anything.

kay and its libraries share one version number, so one section covers them all. A minor that is not listed broke nothing.

## 1.44.0

### kayjs-auth asks for a proof of work

Registering, password resets and magic links now ask for a proof of work by default. So does a password sign-in from the third attempt. The prebuilt pages already carry it.

Your own register, reset or magic-link form needs the proof-of-work field, or its request is refused with `error: 'captcha'`. [Bots](/libraries/kayjs-auth#bots) shows the form and its action. To keep the old behaviour, set `captcha: false` in `createAuth`.

A test posting such a form submits it from the page it visited, so `site.submit` can solve the field:

```ts
await site.submit(register, fields, { from: await site.visit('/register') })
```

A guest sign-in is now checked as `'guest'` rather than `'register'`, with its own `captcha.on.guest`. A custom `captcha.verify` that looks at the action needs to handle it.

### kayjs-auth refuses cross-site requests on a plain Elysia app

On a plain Elysia app mounting `auth.plugin`, a cross-site POST or websocket upgrade from a browser now reads the session as signed out, and a sign-in, a sign-out or any other session write answers a 403. kay's own actions and API already refused these, and an `api({ cors })` module still lets in the origins it names.

Behind a proxy that does not pass the browser's `Host` on, set `url` in `createAuth` to the site's public address. Without it, every form post that touches the session answers a 403.

Only an `Authorization: Bearer` header skips the check. Basic credentials, which a browser sends on its own, are checked like any other request.
