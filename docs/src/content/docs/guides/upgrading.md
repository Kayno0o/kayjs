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
