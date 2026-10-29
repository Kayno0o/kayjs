# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.84.0

### A kayjs-ui `Rating` needs its `label`

- `Rating(value={4.6})` fails `kay check`: give it the text screen readers read, as `Meter` and `Progress` already need, `Rating(value={4.6} label="Rated 4.6 out of 5")`. The `ui.rating.label` message (`{value} out of {max}`) that stood in for a missing one is gone.

### kayjs-ui: `MenuAction.danger` and `Toast.type` are deprecated

- A `MenuAction` with `danger: true` becomes `tone: 'danger'`, which wins when both are given. Both still work until 2.0.0, and the editor strikes them out (`@deprecated`).
- A read of `toasts()[n].type`, or of the `ToastType` type, becomes `tone`, where the old `'error'` is `'danger'`. 2.0.0 makes a toast `{ id, message, tone }`; `toast.error()` stays the method for a failure and pushes a `danger` toast.
### kayjs-ai: a key over plain http, and `AI_PROVIDER=openai` without a key

- A key sent to a plain `http://` API root that is not loopback, such as `AI_BASE_URL=http://ollama:11434/v1` on a compose network with `OPENAI_API_KEY` set, now throws until `AI_INSECURE=true` (or `insecure: true` on `openai()` and `anthropic()`) says the network is trusted; `https://` and `localhost` are unchanged, and a root with no scheme throws naming its variable.
- `AI_PROVIDER=openai` without `OPENAI_API_KEY` throws unless `AI_BASE_URL` names a server. `kay check` cannot recognise either, as both depend on the environment, so there is no deprecated lint.
### A string field of an action is bounded to 10,000 characters

- A string field of an action's schema, or an `s.String`, with no `maxLength` is now refused past 10,000 characters: declare a `maxLength` on a field that takes more, a long text or a pasted document say. `unbounded-string` is a warning now, so a `// kay-allow` or a level it was given stays valid.

### The `island-action` lint is gone

- An island no longer needs `Action` imported to be handed an action, so `island-action` is removed: delete a `// kay-allow island-action` comment or a `lints` entry naming it, which `kay check` now reports as an unknown lint; no `deprecated` lint announces it, as an island still importing `Action` compiles and works as before. `island()` and `promote()` from `kay/island`, which compiled components call, lose their trailing `takesActions` argument, and the `PlainIslandProp` type lets an island's prop hold an action without a type for it.

## 1.82.0

### An `ActionStream` has `ended()`

- An object the app builds as an `ActionStream`, a test's fake stream say, gets a type error from `kay check` until it has `ended: () => Promise<T | undefined>`, resolving with its last value once it ran to its end and rejecting when it failed or was closed ([streaming actions](actions-from-islands.md)). A stream a call resolves with already has it.

### kayjs-auth: the methods of a feature are grouped under it

- `auth.listUsers()` is `auth.admin.listUsers()`, `auth.signInWithPassword(input)` is `auth.password.signIn(input)`, and so on for `password`, `email`, `magicLink`, `twoFactor`, `passkeys`, `sessions`, `tokens`, `oauthServer`, `admin` and `organizations` ([the table](../packages/auth/llms/grouped-methods.md)). The flat names still work until 1.85; `kay upgrade` renames the calls on `auth` and `ctx.locals.auth` (`deprecated-auth-methods`), and a flat method read without a call, destructured, under `typeof` or in a template expression is renamed by hand.

## 1.81.0

### kayjs-auth: a store counts attempts in `rates`, and `DEFAULT_LIMITS` windows are durations

- `attempts` left the `AuthStore` contract. A store of the app's own drops it, attempts then counting in the app's `store.rates` from kay.config.ts, else in memory, or gives `rates`, a kay `RateStore` with `peek` and `reset` over its own database. The old counter is still read, in place of `rates`, until 1.84, and `kay upgrade` (`deprecated-auth-attempts`) drops `attempts: memoryAuthStore().attempts`. `pgStore` keeps its `kay_attempts` table, so its counts survive; a counter the app drops starts its open windows over, a day at most.
- `DEFAULT_LIMITS` and the `Limit` type write a window as a duration, `{ max: 40, window: '15m' }`, where they held seconds (`900`): code reading one as a number gets a type error from `kay check`, and reads it with `durationSeconds`. A `rateLimit` option already took durations and is unchanged.

### `s.UnionEnum` and `s.UnionKeys` no longer default to their first value

- An enum field left out used to read as its first value. An optional one now reads `undefined`; a required one is refused: an action answers 422, a page's `query` schema answers 400 on a visit without the parameter, a `defineEnv` variable left unset stops the boot, and a content field left out fails the build. An app relying on the fill writes `s.UnionEnum(['a', 'b'], { default: 'a' })`, which also keeps the old error body of an `api` route. No lint can recognise it, as the old form is valid and only its result changed.

### kayjs-auth: a `forwardAuth` session cookie is no longer `__Host-` prefixed

- An app with `forwardAuth` and a `session()` naming no `domain` now shares its session cookie under the `forwardAuth` domains, named `kay_session` (or your `cookie`) instead of `__Host-kay_session`, so every signed-in visitor is signed out once and signs in again. The old `__Host-` cookie cannot be shared across hosts, and `auth({ cookie })` only renames the new one, so nothing keeps the old sessions.

### kayjs-ui: a Table over a `list` no longer filters the loaded rows

- Its `filter` search box now hands the typed text to the list's `load` as `filter.text`, the list starting over from offset 0 after a pause in typing, and the loaded rows are not matched against `filter` again. A `load` that ignored the text used to see the box narrow the rows loaded so far; it now has to narrow its pages itself, as it does for `sort` ([Infinite lists](../packages/ui/llms/infinite-list.md)). `kay check` cannot tell what a `load` reads, so there is no lint for it.
- The `filter` part of a Table with a search box is now a `div` holding one `label` per field, drawn by the new `field` part, where it was the `label` itself: a stylesheet or a `src/ui.ts` restyling `filter` moves its label rules to `field` ([Restyle a component](../packages/ui/llms/restyle.md)).

## 1.80.0

### A Button that is disabled with a `data-tooltip` is `aria-disabled`, not `disabled`

- So its reason reaches the keyboard, the button no longer matches `:disabled`: a stylesheet or a test reading `button:disabled` or `toBeDisabled()` on it reads `[aria-disabled='true']` instead, and a locked `type="submit"` button turns `type="button"`. A hand `span(data-tooltip tabindex="0")` wrapped around such a button can go, or become kayjs-ui's `Tooltip`, which `kay check --fix` writes (`hand-tooltip`). No lint can recognise the old form, as `disabled` with a tooltip is valid markup.

## 1.78.0

### A stylesheet setting a Button's shell variables renames them

- `--_shell-line` and `--_shell-fill`, the private variables a stylesheet set to restyle a Button, a framed IconButton or a stat badge, are `--shell-line` and `--shell-fill`, now documented ([Setup](../packages/ui/llms/setup.md)). Set them as utilities on the part in `src/ui.ts`, such as `Button: { parts: { root: '[--shell-line:var(--color-accent)]' } }`. `kay check` cannot tell a private name written in a stylesheet from any other custom property, so no lint reports the old one.

### A form calling kayjs-auth itself carries the proof of work

- Since 1.44, `createAuth` asks a proof of work for registering, resets and magic links, so an app's own form answers `{ ok: false, error: 'captcha' }` until it holds `input(type="hidden" name="captcha" data-kay-work={await auth.captchaChallenge('register')})` (`'reset'`, `'magic-link'` or `'sign-in'` for the others) and its action passes the field on as `{ captcha: input.captcha }`. `kay check` now reports a call with no `captcha` option (`missing-captcha`); `captcha: false` on `createAuth` turns the proof off ([Bots](../packages/auth/llms/hardening-and-testing.md)).

## 1.77.0

### kayjs-auth renames the `auth_*` tables again

- A database still on the pre-1.71 `auth_*` tables moves straight here: the migration `db.sync()` or `bunx pg-orm generate` writes renames them with their rows and adds the columns since, where 1.74 to 1.76 created empty `kay_*` tables beside them.

### kayjs-ui: stepDraft's maxAge is a duration only

- `stepDraft(..., { maxAge: 3600 })` is a type error now: write `maxAge: '1h'`. The deprecated `deprecated-step-draft-max-age` lint is gone with the number form, so run `kay check --fix` on 1.74 to 1.76 before moving.

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

The names folded into a Tailwind step or a recipe have no pair: `--radius-kui-*` is `--radius-sm/md/lg`, `--kui-border-card`, `--kui-border-input`, `--kui-border-badge`, `--kui-border-stamp`, `--kui-border-notice` and `--kui-border-avatar` are the one `--border-width` that draws every frame (an app with `--border-width: 0px` that kept `--kui-border-input: 1px` for its fields sets `--border-width: 1px` on the field, or `[border-width:1px]` on the part in `src/ui.ts`), and the badge, notice, avatar, field and stamp knobs are set on the part in `src/ui.ts`, as are `--kui-badge-case`, `--kui-badge-font`, `--kui-badge-solid-text` and `--kui-field-focus-shadow`; `--color-kui-overlay1` is `--color-muted`, and `--color-kui-fill-hover`, `--color-kui-fill-danger` and the stamp colours are set on the part too.

- A `ui.*` or `cms.*` message key still ending in `Label` (`ui.table.filterLabel`) no longer overrides the library's text: word it as the bare name (`ui.table.filter`), `Aria` where the bare name met a visible text (`cms.admin.searchLabel` is `cms.admin.searchAria`), and `cms.history.restoreLabel` is `cms.history.restoreButton`. The props `loadingLabel`, `backLabel` and the like keep their names.
- `deprecated-ui-prop`, `deprecated-ui-callback`, `deprecated-ui-token` and `deprecated-message-key` are gone with the forms they reported, so run `kay check --fix` on 1.74 before moving. What an app still writes with an old `kui-` name is reported by `removed-ui-token` (a utility such as `bg-kui-surface2`, a `var(--color-kui-muted)`), and `kay check --fix` rewrites it where a new name stands for it.

## 1.74.0

### The forms deprecated in 1.71 are gone

An action's `rateLimit`, `honeypot`, `minTime` and `proofOfWork` on the third argument itself are no longer read, and `kay check` reports them as a type error: put them under `protect: { ... }` ([Protecting actions](action-protection.md#protecting-an-action)). `deprecated-action-options` is gone with the form it moved.

kayjs-ui's `theme.css` has no rule left for the part classes its components stopped setting (`kui-card-head`, `kui-stat-value`, `kui-dialog-title` and the rest listed under 1.71.0 and 1.72.0), nor for the old rule of the roots of Card, Dialog, Menu, Popover, HoverCard, SidePanel, CommandPalette, Toaster, TooltipHost, Badge, Notice, Avatar, Widget, CardRow, Checkbox, RadioGroup, ChipGroup, CopyButton, EmptyState, FileDrop, Meter, Progress, Skeleton, PageHeader, PageSection, DateInput, DateRangeInput, Segmented, Slider, ColorInput, Combobox, MultiSelect, Rating, Toggle and FormField, whose recipes draw the look: markup of yours written by hand with one of those classes is no longer styled, so give it utilities or select `[data-part]` on the component. `deprecated-ui-class` is gone, and a stylesheet selecting a removed class matches nothing.

The selectors a stylesheet moves to, inside the component's root: `.kui-table-row` is `[data-part='row']` (`.kui-table-cell` is `[data-part='cell']`), `.kui-checkbox-input` is `[data-part='input']`, `.kui-line-chart-legend` is `[data-part='legend']` and `.kui-site-nav-list` is `[data-part='list']`. The Table's narrow form is a container named `table` (`@container table`, which was `kui-table`), so a container query on the old name becomes `@container table (max-width: 30rem)`. The part names are the keys of each component's recipe in `packages/ui/src/`.

kayjs-cms answers on `/_kay/cms` alone: the `/api/cms` path of 1.70 and before is no longer served, so point a webhook or a script at the new one.

### The 1.70 names that were read for three minors are gone

- kayjs-mail reads `MAIL_URL`, `MAIL_INSECURE`, `MAIL_DKIM_SELECTOR`, `MAIL_DKIM_PRIVATE_KEY`, `MAIL_DKIM_DOMAIN`, `MAIL_FROM` and `MAIL_RATE_LIMIT` alone: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` (now the login and server of `MAIL_URL`, such as `smtp://user:pass@mail.example.com:465`), `SMTP_INSECURE`, `SMTP_DKIM_*`, `SMTP_FROM` and `SMTP_RATE_LIMIT` are no longer read, so rename them in the deploy's environment.
- `publicEnv` in kay.config.ts is refused at boot: mark the fields `s.Public` in `defineEnv` in a `.ts` module under `src` instead: kay finds public fields only there, so a schema in `common/` or another folder outside `src` types its fields as strings in islands (`kay check` reports it as `public-env-outside-src`). The `publicEnv` an island imports from `kay` stays; the `PublicEnvOf` type is gone.
- The `ORIGIN` env is no longer read for the site's URL: set `SITE_URL`. `kay env` stops listing it.
- `kay migrate astro --out` is `--outdir`, and `kay new --host` is `--forge`; the old flags are unknown options.
- kayjs-ai: the `failed` field of a `ToolOutcome` (`results` of a `ProviderMessage`) is gone, read `ok`; a provider written against `failed` reads `!ok`.
- kayjs-cms: `cms({ logo })` is gone, a type error: give `logo: { src, alt }` in the cms settings module. The `kcms_session` cookie is no longer read, so an editor signed in with the 1.69 cookie signs in again.
- `paginate()`'s result drops `size`, the old name of `pageSize`.

kayjs-auth's `auth_*` tables are no longer `renamedFrom` their old names on 1.74 to 1.76: a database still on `auth_*` tables moves straight to 1.77 or later, whose tables rename them again for good, through the migration `db.sync()` or `bunx pg-orm generate` writes.

### Props typed `Signal<T>` or `Memo<T>` are plain values

A prop typed `Signal<T>` or `Memo<T>` is a plain value of that type now, no longer read by calling it or assigned: type a prop the child writes `Bindable<T>`, read and assign it as `open`, and bind it with `bind:open={open}`; a `Memo<T>` prop is a `T`, passed as `value={memo()}`. `kay check` reports a prop still typed `Signal<T>` or `Memo<T>` from `kay`.

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
