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
- The code focusing the first invalid field of a form the server refused loads when a form is refused, not with every page: the entry is about 150 bytes gzip lighter.
- The code deferring an island to `hydrate="visible"` or `"idle"`, or a server island, is a chunk of its own that only a page with one loads: the entry is about 105 bytes gzip lighter on every other page.
- An island that is not `persist` no longer pays for the code giving a kept island the next page's props: the entry is about 230 bytes gzip lighter on every page, and a `persist` island loads that code as a chunk of its own.
- A static export's entry is 190 bytes gzip lighter: it no longer carries the code reading the build header, which a static host never sends ([Production](production.md)).
- `navigate()` and `refresh()` load with the first action call, redirect or live refresh that needs them, or with the app code importing them, not with every page: the entry is about 190 bytes gzip lighter on every page.
- `health.check` runs at most once every 3 s, the probes between sharing its answer, so a balancer and a container check polling every second no longer hit the database each time ([Production](production.md#check-the-database-in-the-health-route)).
- A collection's feed sends an ETag and answers 304 to a reader holding it ([Content](content.md#serve-an-rss-feed)).
- A link followed while an earlier visit's page is still loading cancels that fetch, so a slow page no longer keeps downloading behind the one shown ([Navigation](navigation.md)).
- A 404 costs the server less: the missing paths are written to `data/not-found.sqlite` in one transaction a second instead of four statements per request, and the runtime redirects are answered from memory that follows the file ([Routing](routing-endpoints-and-base.md)).
- `sqliteRooms` wakes on the file changing instead of reading every 25 ms while a socket is open, falling back to a 250 ms read, which `poll` still sets ([Rooms](api-from-islands.md)).
- A hidden tab closes its live-values connection and stops renewing the proof, and opens the connection again, with every value as it is then, when shown; the entry of a page with live values is about 40 bytes gzip heavier for it ([Live values](api-from-islands.md)).

## 1.55.1

- The `deprecated-api-tool` lint, which only warned while `kay upgrade` moved an app from before 1.51, is gone ([Checks](checks.md)).
- An `_error.kay` drawn for a hook that threw reads the locals your `derive` added before it threw.
- A sitemap built with a `lastmod` left out is kept for a minute, not an hour.
- The analytics notice is fetched again after a failed load and carries the tracker's CSP nonce.
- kayjs-ui `Sortable` names a bare handle after its item (`Reorder Milk`) and leaves an image with `alt` to name it, `mountComponent` mounts a component that `call()`s a library's API, and a numbered CMS list says the place a moved item left ([Drag and drop](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ai `Chat` takes `maxChars` (40,000), to match a lower `maxInputChars` ([Chat](../packages/ai/llms/chat.md)).
- Fathom and Cloudflare keep `'self'` in the policy's `script-src` and `connect-src`; it was replaced, which blocked the site's own scripts ([Privacy](privacy.md)).

Releases before 1.55.1 are in [What's new, older releases](whats-new-archive.md).
