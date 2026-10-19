# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- Fathom, Cloudflare and `custom` with `consent: false` show the information line and the opt-out too, kay loading their script until the visitor opts out, which `info: false` leaves to the app; `custom` loaded through kay's script under a `base` points its tracker at the right route ([Privacy](privacy.md)).
- The lints deprecated in 1.52 go with their old forms: `deprecated-provider-url`, `deprecated-store-verb`, `deprecated-sign-in-options`, `deprecated-auth-event`, `deprecated-time-ms` (a bare number of milliseconds now throws), `deprecated-test-mount`, `deprecated-ui-prop`; see [Upgrading](upgrading.md).
- kayjs-auth no longer counts a passkey made without user verification as a way in: `passkeys()` lists `userVerified`, see [Upgrading](upgrading.md).
- kayjs-auth: a bearer or OAuth token can no longer create or rename an organization, send, list or revoke invitations, or accept or decline one ([kayjs-auth](../packages/auth/llms/admin-and-organizations.md)).
- `deprecated-analytics-consent` also reads `as const`, `satisfies`, a template-literal provider and options held in a variable; Fathom and Cloudflare with `consent` unset are covered by a browser test ([Lints](lints.md)).
- `consent.set()` before the tracker loads keeps `consent.maxAge`, and `analytics()` refuses an unused `info` (lint `deprecated-analytics-info`) ([Privacy](privacy.md)).
- kayjs-auth `register` under `requireVerified` runs `onSignUp`, and the `onDelete` of an unverified account it replaces, after the response, so a free address answers as fast as a held one ([Passwords and mails](../packages/auth/llms/passwords-and-mails.md)).
- kayjs-auth no longer resets the account-wide sign-in ceiling when the holder signs in, and mails `sign-in-locked` at most once a day per account ([Limits](../packages/auth/llms/hardening-and-testing.md)).
- kayjs-ui `Sortable` names a handle after its item's text without its other controls (`Reorder Milk`, not `Reorder Milk Delete`) and renames it when that text changes ([Drag and drop](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ai `Chat` learns a lower `maxInputChars` of the action's `ask` from its 413, posting less and asking again, so the app states it once ([Chat](../packages/ai/llms/chat.md)).
- `kay/server` exports `typeOfName` and `holdsType`, the file route's name-to-type rule and its image and PDF signature checks, which kayjs-cms now uses to judge an upload instead of its own copies ([Files](files.md#storing-and-linking)).

## 1.55.1

- The `deprecated-api-tool` lint, which only warned while `kay upgrade` moved an app from before 1.51, is gone ([Checks](checks.md)).
- An `_error.kay` drawn for a hook that threw reads the locals your `derive` added before it threw.
- A sitemap built with a `lastmod` left out is kept for a minute, not an hour.
- The analytics notice is fetched again after a failed load and carries the tracker's CSP nonce.
- kayjs-ui `Sortable` names a bare handle after its item (`Reorder Milk`) and leaves an image with `alt` to name it, `mountComponent` mounts a component that `call()`s a library's API, and a numbered CMS list says the place a moved item left ([Drag and drop](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ai `Chat` takes `maxChars` (40,000), to match a lower `maxInputChars` ([Chat](../packages/ai/llms/chat.md)).
- Fathom and Cloudflare keep `'self'` in the policy's `script-src` and `connect-src`; it was replaced, which blocked the site's own scripts ([Privacy](privacy.md)).

Releases before 1.55.1 are in [What's new, older releases](whats-new-archive.md).
