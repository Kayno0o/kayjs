# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- `overrideEnv(env, values)` from `kay/test` gives a `defineEnv` value other variables for one test and puts them back, and `defineEnv`'s `source` argument is documented ([Testing](testing.md), [Server](server.md)).
- kayjs-auth's `auth.sessionCookie` mints the `__Host-session` cookie an https site reads, in production when kay.config.ts `site` is https or with `{ secure: true }` ([Hardening and testing](../packages/auth/llms/hardening-and-testing.md)).
- kayjs-ui's `attempt` and ConfirmDelete read the `ApiError` that `call()` throws as they do an action's refusal: the route's own words are toasted for a 4xx when they read as a message (not markup, a status code or a page), `refused` reads its `answer`, and `failure` stands for status 0 or a 5xx ([kayjs-ui](../packages/ui/llms/basics.md)).
- kayjs-ui `Segmented` takes number option values, and `onChange` hears the option's own type ([Tables, navigation and layout](../packages/ui/llms/tables-navigation-and-layout.md)).
- The metric-matched font fallback also covers Roboto (a sans) and fits Noto Serif (a serif), so on Android and on a Linux machine without Arial-compatible fonts it loads instead of leaving the text to shift as the font swaps in ([Fonts](sitemap-search-fonts.md#fonts)); the page's inline `<style>` grows by about 200 bytes (40 gzipped) per serif family and about 60 bytes (16 gzipped) per sans family, which only lists Roboto beside Arial.
- The link check counts the source of a `redirects` entry, in the config or added while the site runs, as served, so a link, `ctx.redirect`, a guard's `redirect` or `navigate()` to it passes ([Checks](checks.md)).

## 1.57.1

- The `AGENTS.md` that `kay new` writes tells agents to set `seo.name`, which every page title ends with, to the site's real name instead of the folder name ([Project](project.md)).

## 1.57.0

- The analytics tracker counts nothing for a page a guard covers, with no `exclude` ([Privacy](privacy.md)); see [Upgrading](upgrading.md).
- kayjs-auth binds OAuth tokens to the `resource` asked at authorize: the token request and a refresh may name it again or leave it out, any other is `invalid_target`, several `resource` parameters are refused at authorize as at the token endpoint, and a refresh refused for its resource or scope, or a code exchange refused for its resource or `redirect_uri`, keeps its token or code for the retry (with a store that has `oauth.refresh.get` or `oauth.codes.get`) ([OAuth server](../packages/auth/llms/oauth-server-and-tokens.md)); see [Upgrading](upgrading.md).

## 1.56.1

- `custom` analytics with `info: false` under a `base` names the base in its head tag too, so an app behind a proxy that takes the base off serves the tracker with the collect route under the base.
- `kay check` warns (`large-public-image`) of an `img` using a public image over 256 KiB, which is sent unresized; import it from `src/` instead ([images](images.md)).
- `kay check` points the `seo` and favicon lints of `kay.config.ts` at the key they are about (the `defineConfig` call for one that is missing), not at line 1 ([Lints](lints.md)).
- The analytics server drops a visit to an `exclude` path too, so a tracker a browser cached for an hour counts nothing for it either ([Privacy](privacy.md)).
- A page whose lazy runtime chunk fails to load with the build unchanged (offline, a dev server restarting) stays correct: the page an action refreshes loads in full, and an island hydrating on `visible` or `idle` hydrates at once instead of staying inert ([Production](production.md)).
- A page with an island hydrating on `visible` or `idle` preloads the code waiting for it, so those islands hydrate about one round trip sooner ([Build and start](build-and-start.md)).
- A page with an island hydrating on `visible` or `idle`, or a deferred server island, preloads the code waiting for it, so those islands hydrate about one round trip sooner ([Build and start](build-and-start.md)).
- A page whose lazy runtime chunk fails to load with the build unchanged (offline, a dev server restarting) stays correct: the page an action refreshes reloads (unless something was typed), and an island hydrating on `visible` or `idle` hydrates at once instead of staying inert ([Production](production.md)).
- A page carrying inlined stylesheets whose gzip is kept is found from the pieces its render put it together from, without reading or searching its body: about 8% less main-thread time per request on a page with 110 KB inlined, and the response a hook or a test reads is unchanged.

## 1.56.0

- `kay dev` writes its types without looking for the problems only `kay check` reports, and `kay check` skips them for a library's components it does not reach: about 0.25 s of CPU less on a cold start.
- `kay dev` no longer spends a core of its server process, about 0.45 s of CPU on a cold start, while the server waits for the first client build.
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
- The variants the image route draws on request (runtime, stored and remote images) are removed after 30 days, at start and once a day, where they stayed for good ([Images](images.md)).
- The default image ladder stops at 2560 px and no variant is wider than its last width, so a large photograph builds and serves fewer, smaller files; list `3840` in `images.widths` for wider screens, see [Upgrading](upgrading.md).

## 1.55.1

- The `deprecated-api-tool` lint, which only warned while `kay upgrade` moved an app from before 1.51, is gone ([Checks](checks.md)).
- An `_error.kay` drawn for a hook that threw reads the locals your `derive` added before it threw.
- A sitemap built with a `lastmod` left out is kept for a minute, not an hour.
- The analytics notice is fetched again after a failed load and carries the tracker's CSP nonce.
- kayjs-ui `Sortable` names a bare handle after its item (`Reorder Milk`) and leaves an image with `alt` to name it, `mountComponent` mounts a component that `call()`s a library's API, and a numbered CMS list says the place a moved item left ([Drag and drop](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ai `Chat` takes `maxChars` (40,000), to match a lower `maxInputChars` ([Chat](../packages/ai/llms/chat.md)).
- Fathom and Cloudflare keep `'self'` in the policy's `script-src` and `connect-src`; it was replaced, which blocked the site's own scripts ([Privacy](privacy.md)).

Releases before 1.55.1 are in [What's new, older releases](whats-new-archive.md).
