# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.74.0

### The forms deprecated in 1.71 are gone

An action's `rateLimit`, `honeypot`, `minTime` and `proofOfWork` on the third argument itself are no longer read, and `kay check` reports them as a type error: put them under `protect: { ... }` ([Protecting actions](action-protection.md#protecting-an-action)). `deprecated-action-options` is gone with the form it moved.

kayjs-ui's `theme.css` has no rule left for the part classes its components stopped setting (`kui-card-head`, `kui-stat-value`, `kui-dialog-title` and the rest listed under 1.71.0 and 1.72.0), nor for the old rule of the roots of Card, Dialog, Menu, Popover, HoverCard, SidePanel, CommandPalette, Toaster, TooltipHost, Badge, Notice, Avatar, Widget, CardRow, Checkbox, RadioGroup, ChipGroup, CopyButton, EmptyState, FileDrop, Meter, Progress, Skeleton, PageHeader, PageSection, DateInput, DateRangeInput, Segmented, Slider, ColorInput, Combobox, MultiSelect, Rating, Toggle and FormField, whose recipes draw the look: markup of yours written by hand with one of those classes is no longer styled, so give it utilities or select `[data-part]` on the component. `deprecated-ui-class` is gone, and a stylesheet selecting a removed class matches nothing.

kayjs-cms answers on `/_kay/cms` alone: the `/api/cms` path of 1.70 and before is no longer served, so point a webhook or a script at the new one.

kayjs-auth's `auth_*` tables are no longer `renamedFrom` their old names. A database still on `auth_*` tables must take 1.71 to 1.73 first, apply the migration `db.sync()` or `bunx pg-orm generate` writes there, and only then move to 1.74: from 1.74 the generator no longer renames them, so it would create the `kay_*` tables beside the old ones, empty.

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
- Still deprecated: `deprecated-signal-prop`, as props typed `Signal<T>` or `Memo<T>` are still compiled.

Releases before 1.73 are in [Upgrading, older releases](upgrading-archive.md).
