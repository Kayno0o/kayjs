# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.76.0

### A restricted-role Postgres app creates `kay_push_subscriptions` before listing `push()`

- Nothing changes for an app that does not list `push()`. One that does, on a Postgres whose app role may not create tables, has the owner create `kay_push_subscriptions` once, as it does for the other `kay_` tables ([Queues](queues.md)).

### A component generic in its option value casts the `options` it hands Segmented or RadioGroup

- kayjs-ui type-checks a null option against the group's `value`, so a wrapper whose option value is a type parameter (`<V>` passing `options: { value: V }[]` through) fails `kay check` on `options` and casts what it passes. A wrapper with concrete option types changes nothing ([Segmented](../packages/ui/llms/tables-navigation-and-layout.md)).

## 1.75.0

### The forms deprecated in 1.72 are gone

- kayjs-ui's old prop names are no longer read: `Select` takes `busy` (not `loading`), `QrCode` `pixels` (not `size`), `Badge` `variant="stamp"` or `variant="solid"` (not `stamp` or `solid`), and `FormField`, `FileDrop` and `Notice` `size="sm"` (not `compact`). A prop left under its old name does nothing.
- `ConfirmDelete`'s `onOpen` and `SplitLayout`'s `onSidebarClose` are gone: use `onOpenChange` (called with `false` on closing too, so `onOpenChange={open => open && ask()}` keeps running on opening alone) and `onSidebarOpenChange(false)`.
- The old `kui-` theme tokens no longer alias the app's own names, and the components stop reading them first. Set the new name in your `@theme`, write `bg-border` for `bg-kui-surface2`, and read `var(--color-muted)` for `var(--color-kui-muted)`: a utility still written with an old name builds nothing, and an old name set in `@theme` or on an element changes nothing. `--font-label` has no default declaration any more: it falls back to the text's own font.

| Old | New |
| --- | --- |
| `--color-kui-canvas`, `text` | `--color-background`, `--color-foreground` |
| `--color-kui-accent`, `success`, `warning`, `info` | `--color-accent`, `--color-success`, `--color-warning`, `--color-info` |
| `--color-kui-error` | `--color-danger` |
| `--color-kui-field-border`, `field-focus` | `--color-input`, `--color-ring` |
| `--color-kui-mantle`, `surface0`, `surface1`, `surface2` | `--color-popover`, `--color-surface`, `--color-surface-strong`, `--color-border` |
| `--color-kui-overlay0` | `--color-border-strong` |
| `--color-kui-muted`, `subtext0` | `--color-muted` |
| `--color-kui-accent-hi`, `on-accent`, `row-hover` | `--color-accent-hover`, `--color-accent-foreground`, `--color-hover` |
| `--color-kui-chart-1` to `6` | `--color-chart-1` to `6` |
| `--text-kui-2xs` (and its `--line-height`), `--tracking-kui-label` | `--text-2xs`, `--tracking-label` |
| `--kui-density`, `--kui-label-case`, `--kui-label-font`, `--kui-border-width` | `--density`, `--label-case`, `--font-label`, `--border-width` |
| `--kui-shadow-raised`, `--kui-shadow-press`, `--kui-press-travel` | `--shadow-raised`, `--shadow-press`, `--press-travel` |
| `--kui-table-height`, `--kui-line-chart-height`, `--kui-bar-chart-height`, `--kui-scatter-chart-height`, `--kui-zoom-scale` | `--table-height`, `--chart-height` (the three charts), `--zoom-scale` |

The names folded into a Tailwind step or a recipe have no pair: `--radius-kui-*` is `--radius-sm/md/lg`, `--kui-border-*` is `--border-width`, and the badge, notice, avatar, field and stamp knobs are set on the part in `src/ui.ts`, as are `--kui-badge-case`, `--kui-badge-font`, `--kui-badge-solid-text` and `--kui-field-focus-shadow`; `--color-kui-overlay1` is `--color-muted`, and `--color-kui-fill-hover`, `--color-kui-fill-danger` and the stamp colours are set on the part too.

- A `ui.*` or `cms.*` message key still ending in `Label` (`ui.table.filterLabel`) no longer overrides the library's text: word it as the bare name (`ui.table.filter`), `Aria` where the bare name met a visible text (`cms.admin.searchLabel` is `cms.admin.searchAria`), and `cms.history.restoreLabel` is `cms.history.restoreButton`. The props `loadingLabel`, `backLabel` and the like keep their names.
- `deprecated-ui-prop`, `deprecated-ui-callback`, `deprecated-ui-token` and `deprecated-message-key` are gone with the forms they reported, so run `kay check --fix` on 1.74 before moving.

## 1.74.0

### The forms deprecated in 1.71 are gone

An action's `rateLimit`, `honeypot`, `minTime` and `proofOfWork` on the third argument itself are no longer read, and `kay check` reports them as a type error: put them under `protect: { ... }` ([Protecting actions](action-protection.md#protecting-an-action)). `deprecated-action-options` is gone with the form it moved.

kayjs-ui's `theme.css` has no rule left for the part classes its components stopped setting (`kui-card-head`, `kui-stat-value`, `kui-dialog-title` and the rest listed under 1.71.0 and 1.72.0), nor for the old rule of the roots of Card, Dialog, Menu, Popover, HoverCard, SidePanel, CommandPalette, Toaster, TooltipHost, Badge, Notice, Avatar, Widget, CardRow, Checkbox, RadioGroup, ChipGroup, CopyButton, EmptyState, FileDrop, Meter, Progress, Skeleton, PageHeader, PageSection, DateInput, DateRangeInput, Segmented, Slider, ColorInput, Combobox, MultiSelect, Rating, Toggle and FormField, whose recipes draw the look: markup of yours written by hand with one of those classes is no longer styled, so give it utilities or select `[data-part]` on the component. `deprecated-ui-class` is gone, and a stylesheet selecting a removed class matches nothing.

kayjs-cms answers on `/_kay/cms` alone: the `/api/cms` path of 1.70 and before is no longer served, so point a webhook or a script at the new one.

### The 1.70 names that were read for three minors are gone

- kayjs-mail reads `MAIL_URL`, `MAIL_INSECURE`, `MAIL_DKIM_SELECTOR`, `MAIL_DKIM_PRIVATE_KEY`, `MAIL_DKIM_DOMAIN`, `MAIL_FROM` and `MAIL_RATE_LIMIT` alone: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` (now the login and server of `MAIL_URL`, such as `smtp://user:pass@mail.example.com:465`), `SMTP_INSECURE`, `SMTP_DKIM_*`, `SMTP_FROM` and `SMTP_RATE_LIMIT` are no longer read, so rename them in the deploy's environment.
- `publicEnv` in kay.config.ts is refused at boot: mark the fields `s.Public` in `defineEnv` instead. The `publicEnv` an island imports from `kay` stays; the `PublicEnvOf` type is gone.
- The `ORIGIN` env is no longer read for the site's URL: set `SITE_URL`. `kay env` stops listing it.
- `kay migrate astro --out` is `--outdir`, and `kay new --host` is `--forge`; the old flags are unknown options.
- kayjs-ai: the `failed` field of a `ToolOutcome` (`results` of a `ProviderMessage`) is gone, read `ok`; a provider written against `failed` reads `!ok`.
- kayjs-cms: `cms({ logo })` is gone, a type error: give `logo: { src, alt }` in the cms settings module. The `kcms_session` cookie is no longer read, so an editor signed in with the 1.69 cookie signs in again.
- `paginate()`'s result drops `size`, the old name of `pageSize`.

kayjs-auth's `auth_*` tables are no longer `renamedFrom` their old names. A database still on `auth_*` tables must take 1.71 to 1.73 first, apply the migration `db.sync()` or `bunx pg-orm generate` writes there, and only then move to 1.74: from 1.74 the generator no longer renames them, so it would create the `kay_*` tables beside the old ones, empty.

### Props typed `Signal<T>` or `Memo<T>` are plain values

A prop typed `Signal<T>` or `Memo<T>` is a plain value of that type now, no longer read by calling it or assigned: type a prop the child writes `Bindable<T>`, read and assign it as `open`, and bind it with `bind:open={open}`; a `Memo<T>` prop is a `T`, passed as `value={memo()}`. `kay check` reports a prop still typed `Signal<T>` or `Memo<T>` from `kay`.
### kayjs-ui: stepDraft's maxAge is a duration

`stepDraft(ctx.cookies, name, { maxAge: 3600 })` is `maxAge: '1h'`, as every duration in kay is. A number of seconds works until 1.77, and `kay upgrade` (`deprecated-step-draft-max-age`) rewrites a numeric literal at the call.

## 1.73.0

### kayjs-cms: the editor panel is kayjs-ui's docked `SidePanel`

A site's CSS written against the editor's own markup changes. `.kcms-editor-open`, `.kcms-marker-menu`, `.kcms-editor-grip` and the variables `--kcms-side`, `--kcms-bottom` and `--kcms-top` are gone: the panel is a `dialog.kcms-editor[open]` and the marker choice menu is `#kcms-marker-menu`. The editor's inner classes `.kcms-editor-head`, `-body`, `-title` and `-pending`, `.kcms-dock-side`, `.kcms-dock-bottom` and `.kcms-marker-item` are gone too. `--kcms-width` and `--kcms-height` on `html.kcms-editing` stay but now follow the panel's dock, and are `0px` along the edge it is not docked to. A collapsed editor is the `[data-part='launcher']` button of the `SidePanel` with `aria-controls="kcms-editor"` (`.kcms-editor-toggle` is gone). The bar over a page image is a floating kayjs-ui `Toolbar` (`.kcms-image-bar` stays), and its CSS rule is gone. An app that sets the word `cms.editor.label` in its catalog can drop it: the panel is named by `cms.editor.title`, and the key is ignored. See [the editor's dock](../packages/cms/llms/editor.md).

### kayjs-cms: the editor's heads, bars and question are kayjs-ui parts

An entry's head is a `PageSection` head: `.kcms-entry-head`, `.kcms-entry-title` and `.kcms-entry-collection` are gone for `.kcms-entry > [data-part='head']` with its `[data-part='title']` and `[data-part='subtitle']`. The buttons over a page list item are a floating `Toolbar` (`.kcms-list-bar`, `.kcms-list-start`), so `.kcms-list-caption` is `[data-part='caption']`. Stop editing's question over unsaved edits is a `Dialog`: `.kcms-editor-confirm` and `.kcms-editor-choice` are gone. A site CSS on one of them moves to the part, or to `--kui-sticky-top` for a header it must clear.

### The forms deprecated in 1.69 and 1.70 are gone

`deprecated-identity-key` and fourteen of the `since: '1.70'` lints go with the forms they reported: an app still on one gets a type error or an unknown option, bar a `JSX.Element` markup prop.

- `// kay-allow` comments and `lints` entries naming a removed lint are an unknown lint: delete them.
- Config: `authPages`, `authExtension` and `mailExtension` are `auth({ module })` and `mail({ module })`; `bodyLimit` is `maxSize`; `kayjs-cms/postgres` is `kayjs-cms/pg`.
- Durations: a bare number is a type error, `DurationText` is `Duration`.
- Names: `limit` and `visitor` of `ai()` and `ask()` are `rateLimit` and `key`, kayjs-auth's `limits` is `rateLimit`, kayjs-mail's `smtp({ rateLimit })` takes `{ max, window }`; `expires`, `expiresIn`, `rememberMaxAge`, `tokenMaxAge`, `marginMs`, `invitationMaxAge` and `session.lifetime()` are `maxAge`; `createAuth({ url, site: 'Name' })` is `site` (the origin) and `name`; `forgejo({ url })` is `baseUrl`; kayjs-mail's `lang` is `locale`; `infiniteList({ size })` is `pageSize`; `data-cms-edit-page` is `data-kcms-edit-page`.
- kayjs-auth's `AuthMailMessage` and `MailData` have no `site` and no `expires`: a template reads `name` and `maxAge`.
- Exports: `HydrationMismatch`, `ActionRedirect`, `CspViolation`, `RedirectRefused`, `SaveConflict` and `MailNotConfigured` end in `Error`; kayjs-mail's `Message`, `Field`, `Settings` and `defaults`, kayjs-ui's `Settings` and `defaults`, kayjs-auth's `Mail`, `Mailer` and `memoryStore` take a `Mail`, `Ui` or `Auth` prefix (`MailMessage`, `uiDefaults`, `memoryAuthStore`).
- kayjs-auth methods: `sessions`, `tokens`, `members` and the like are `listSessions`, `listTokens`, `listMembers`; `organization` and `invitation` are `getOrganization` and `getInvitation`; `endSession`, `removePasskey`, `removeMember`, `declineInvitation`, `setLocale` and the like are `revokeSession`, `revokePasskey`, `deleteMember`, `rejectInvitation`, `updateLocale`.
- Tests: `mountComponent('src/components/toggle.kay')` takes the imported component; `ctx.failed(action)` and `ctx.succeeded(action)` are `action.failed()` and `action.succeeded()`; a `JSX.Element` markup prop is a `Snippet`, no longer reported.
- Hooks take one event object (`onSignUp({ user, profile })`, `onError({ error, request })`): the positional shape is no longer read.

Releases before 1.73 are in [Upgrading, older releases](upgrading-archive.md).
