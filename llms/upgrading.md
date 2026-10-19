# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.58.0

### kayjs-auth users carry `data` and `providers`

- A `User` has `data` (what the `user` schema keeps, `{}` without one) and `providers` (the id of each linked provider), and `Auth` has a fourth generic, the data's type, so a `User` literal in a test or a mock needs both fields and an exact `toEqual` on a returned user gains `data: {}` and `providers: {}`. Guards, gates, predicates, admin lists, `signInAsGuest`, `register` and `createUser` work with `BareUser`, a `User` without `providers`. An app's own `(user: User) =>` annotations on predicates, `authorize`, the profile's `load` and `save` and `memberOf` must become `BareUser`, which `strictFunctionTypes` enforces.
- With pg-orm, generate a migration for the new `auth_user.data` column (jsonb, not null, default `{}`, so rows stored before it read back `{}`). A custom store keeps and returns `data` on `UserRecord` as JSON; it is optional, and a store that drops it reads as `{}`. `kay check` cannot recognise this, so there is no lint.
- `createAuth({ secret })` is optional: left out, kayjs-auth derives its key from the session's secret. An app that keeps `secret` changes nothing; one that drops it must read the secret section of the kayjs-auth setup first, as what is sealed under the old secret no longer opens.
### kayjs-ui's keyline token is `--kui-border-width`

- Rename `--kui-border-card` to `--kui-border-width` in the skin, whose value is a length such as `2px`: the old name keeps working until 1.61. The keyline now also sizes cards, card heads, card rows, widgets, toasts, dialogs, side panels, tooltips, tables, boxed sections, save bars, segmented controls, file drops, pagination steps, the site nav and chart tooltips, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. No lint can recognise it: kay check does not read an app's CSS.

### kayjs-ui derives its palette from eight seeds

- `surface0`, `surface1`, `mantle`, `fill-hover`, `fill-danger`, `subtext0`, `overlay1`, the hairlines and `accent-hi` are mixed from `canvas`, `text`, `accent` and `error` unless the skin sets them, so a skin that set a seed and left its derived colours at the old defaults now sees them follow the seed: set the derived colour too to keep it. `on-accent` is now the canvas (it was `#fff` in light and `#1a0d0b` in dark), `row-hover` derives from `text`, and `chart-3` and `chart-4` follow `info` and `warning`, so a skin that set those seeds sees them move; set them to keep the old ones. A skin that sets every colour is unchanged. No lint can recognise it.

## 1.57.0

### analytics no longer counts pages behind a guard

- A page a guard covers (`requireGuards` included) carries `<meta name="kay-guarded">` and the tracker counts nothing for it, so the numbers of an app that counted `/account` or an admin area drop to what is public. An app that wants a guarded page counted has no option for it yet; no lint can recognise the old behaviour, so none ships.

### kayjs-auth OAuth tokens are bound to their resource

- The OAuth server keeps the `resource` (RFC 8707) asked at authorize with the code, the bearer token and the refresh token. A token request or a refresh naming a resource other than the one asked at authorize, or (for the code exchange) any resource where none was asked, answers `invalid_target`; one that names it again or none works as before. A refresh token stored before the columns stays unbound and accepts a resource of the site.
- With pg-orm, generate a migration for three nullable columns: `auth_oauth_code.resource`, `auth_oauth_refresh.resource` and `auth_bearer_token.oauth_resource` (no default: rows stored before them read back `null` and stay unbound and working). A custom store keeps and returns `resource` on `OAuthCodeRecord` and `OAuthRefreshRecord` and `resource` in a bearer token's `oauth`, all optional, and may add `oauth.refresh.get(digest)` and `oauth.codes.get(digest)`, which read a refresh token or a code without spending it (a refresh or a code exchange refused for what it asks then leaves it unspent; without them it is spent first, as before). `kay check` cannot recognise this, so there is no lint.

## 1.56.0

### The forms deprecated in 1.52 are gone

- An app still on them stays on `~1.55` and runs `kay check --fix --since 1.52` first, which rewrites what it can, then moves to 1.56. These now fail or are ignored, and `kay check` no longer reports them.
- kayjs-auth: `discordProvider({ apiBase })` is `discordProvider({ url })`; `apiBase` is ignored.
- kayjs-auth: a custom store names `members.delete` and `oauth.grants.upsert`; one with only `members.remove` or `oauth.grants.put` fails where kayjs-auth calls the missing method.
- kayjs-auth: `redirect`, `remember` and `captcha` go in the trailing options object of `signInWithPassword` and `register`, and `requestMagicLink` and `signInWithPasskey` take `redirect` there, not as an argument of its own; in the input or as a positional argument they are ignored, so a captcha is not sent and a redirect leads home.
- kayjs-auth: `createAuth({ onEvent })` is `onAuthEvent`, which gets one object, `{ event, user, context, ...fields }`; `onEvent` is never called.
- A bare number throws, where it was milliseconds, in `every`, `debounced`, `rooms.coalesce({ wait })`, `sqliteRooms({ poll })`, kayjs-cms's `forgejo({ timeout })` and `createDrafts({ delay })`, and in a `Carousel`'s `autoplay`: write `'3s'` or `'250ms'`. The options take the string alone (`DurationText`), so `kay check` reports a number as a type error.
- `kay/test` has no `mount`: it is `mountComponent`, which `kay/mount`'s `mount` never was.
- kayjs-ui: `Dialog`, `SidePanel` and `FormDialog` take `onOpenChange(open)` alone, `Popover` too, so `onClose` and `onToggle` are never called and a `Dialog`, `SidePanel` or `FormDialog` without `onOpenChange` throws when it closes; `Button`, `CopyButton`, `IconButton`, `Menu` and `ConfirmDelete` take `variant` as `solid`, `ghost` or `inline` and the meaning as `tone` (`variant="danger"` is `tone="danger"`, `variant="accent"` `tone="accent"`, `variant="default"` is `variant="solid"`), and an unknown `variant` is drawn as it is; `Notice` has `tone="danger"`, not `error`; `BarList`, `MediaGallery` and `ScatterChart` take `emptyLabel`, not `empty`, and the catalog keys `ui.barList.empty`, `ui.mediaGallery.empty` and `ui.scatterChart.empty` are no longer read, they are `emptyLabel`.

### The default image ladder stops at 2560 px

- `images.widths` defaults to `[320, 640, 960, 1280, 1920, 2560]`, and an image is served at no width past the last one, its own size included, where it also had a 3840 px variant and one at its own size. A site whose photographs must stay sharp on 4K screens sets `images: { widths: [320, 640, 960, 1280, 1920, 2560, 3840] }`; a list of `images.widths` of your own is unchanged, own size included. The image route refuses a width past the default ladder, so a cached page still linking `w=3840` or an image's own size gets a 400 until it is rebuilt. `kay check` cannot recognise a changed default, so there is no lint.

### kayjs-auth passkeys carry `userVerified`

- A passkey record has `userVerified: boolean`, and a passkey with `false` is no way in, as sign-in refuses it: `removePasskey` and `unlink` count only passkeys that proved it. With pg-orm, generate a migration for the new `auth_passkey.user_verified` column (default `false`, so every passkey stored before it, a working one too, counts as a way in only after its next sign-in or re-proof with user verification, and until then `unlink` refuses the last provider of a user whose other way in it was); a custom store keeps and returns `userVerified` (and accepts it in `passkeys.update`). `kay check` cannot recognise this, so there is no lint.

### kayjs-auth organization changes need a session

- `createOrganization`, `updateOrganization`, `invite`, `invitations`, `revokeInvitation`, `acceptInvitation` and `declineInvitation` answer `signed-out` (`declineInvitation` false) to a bearer or OAuth token, as `deleteOrganization` and `setMemberRoles` already did: call them from the user's session, not an API key. Reading calls still accept a token. `kay check` cannot recognise this, so there is no lint.

### analytics `exclude` and `titles` are type errors for Fathom, Cloudflare and `custom`

- `analytics({ provider: 'fathom' | 'cloudflare' | 'custom', exclude, titles })` is a type error in `kay check` and the editor; the server already refused it at start, so no running app changes. Remove the option. No lint ships, as `kay check` reports the type error itself.

### analytics refuses an `info` object where nothing shows it

- `analytics()` throws at start for `info: { ... }` when `consent` asks (Google Analytics, Fathom, Cloudflare and `custom` ask unless `consent: false`); it did nothing there. Remove it, or write `consent: false` to show the line; `info: false` stays valid. `deprecated-analytics-info` finds it and `kay upgrade` removes it.

### kayjs-auth runs `onSignUp` after the response under `requireVerified`

- `register` with `requireVerified` (on by default once `email` is set) returns before `onSignUp` has finished, and before the `onDelete` of an unverified account it replaces, so a free address answers as fast as a held one. An app that reads what `onSignUp` wrote right after `register` returns waits for it another way, or sets `email: { requireVerified: false }`, where it still runs before the response. A throwing `onSignUp` is only logged then, and `register` still succeeds. No lint can recognise this: it is a change of timing in a hook's use.

Releases before 1.56 are in [Upgrading, older releases](upgrading-archive.md).
