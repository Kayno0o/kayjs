# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- Every public DOM event is `<lib>:<verb>` on `document` with an object `detail`: `kay:renew`, `kay:install`, `kay:dev-built`, `kay:dev-types`, `kai:chat-open`, `kai:chat-send`, `kai:chat-draft` and `kui:hold-defaults`; the old names fire too until 1.103, and `deprecated-event-names` finds what `kay check` can read, with a fix where the handler changes nothing else. Cookies are `kay_<name>` and storage keys `<lib>:<name>`, in one [table of events and the two rules](events.md).
- `analytics()` and `vitals()` take `awaitConsent` in place of `consent`, which now names only the visitor's answer; kayjs-ai's `ask()` takes `effort` and `approval` in place of `reasoning` and `confirm`, and `Chat` takes `showReasoning` and `waitingLabel` in place of `reasoning` and `thinkingLabel`. The old names keep working and `kay upgrade` renames them ([analytics](analytics.md), [upgrading](upgrading.md)).
- kayjs-ui: a RowsField `@cell` is drawn once per row and keeps its control when a row above it is removed or added; its `index` is now a function, `index()`, so the cell's name follows the row ([RowsField](../packages/ui/llms/forms.md), upgrade line in [upgrading](upgrading.md)).

## 1.98.0

- `analytics()` takes `url` for the service address (`host` before), `site` for Plausible and Simple Analytics, and `privacy` for the policy link (`policyUrl` before); the old names keep working and `kay upgrade` renames them, and the site options are in one table ([analytics](analytics.md)).
- Every `guard` option takes a guard, a list of guards run in order, or `{ load }`: `jobs`, `images`, `vitals()` and `cms()`, and `false` opens the screens of `vitals()` and `cms()`, closed without a guard ([guards](guards.md#path-and-guard-options)).
- `serve.apiPrefix` names where the API is served, `apiPath` still read and renamed by `kay upgrade`; `live.rateLimit`, `images.rateLimit` and `mcp.rateLimit` are `{ max, window }` in place of `perMinute` and a bare number, as every rate limit option is; a Fontsource font takes `weight` beside `subset` as aliases of `weights` and `subsets`, and `manifest.themeColor` takes a `{ light, dark }` pair (`deprecated-config-keys`; [site config](sitemap-search-fonts.md)).
- `schedule()` takes `timeZone`, as `kay.config.ts` names it, in place of `tz`, which keeps working and which `kay upgrade` renames ([background jobs](production.md)).
- A workflow's `start(input, { key })` names the run as `enqueue`'s `key` names a job, in place of `id`, which keeps working and which `kay upgrade` renames; `id` stays the generated identity a run returns ([queues](queues.md)).
- kayjs-ui: `title` is a string or a `@title` block on Dialog, SidePanel, FormDialog and ConfirmDelete, as on Card, with `label` naming the dialog for screen readers when it differs from the visible title; `heading` is deprecated. `Stat`, and `Chat` and `ChatLauncher` of kayjs-ai, take `layout` where `variant` was, `variant` naming only the frame of a control, and write `data-layout` in place of `data-variant` (an app's CSS on the old attribute changes, see [upgrading](upgrading.md)); `layout` wins over `variant` when both are given. `deprecated-ui-props` rewrites both old names ([blocks](../packages/ui/llms/slots-and-links.md), [lints](lints.md)).
- kayjs-ui: `Tooltip` takes an `@content` block for markup in place of `text`, and `Popover` takes `role` (`dialog` by default) and `label`, its trigger's `aria-haspopup` following the role; Menu, AppSwitcher and Bell panels are `role="none"` around their own list ([popovers and tooltips](../packages/ui/llms/basics.md)).
- A FormField showing a message (its own `issue` included) marks its control invalid in the server render too, `aria-invalid="true"` on a native field, so a refreshed form keeps the mark; `describeField` takes `invalid`, and a RowsField, Checkbox or Toggle in a static FormField is marked once the browser has it, as the choice groups are ([forms](../packages/ui/llms/forms.md), [describeField](islands-state-to-ids.md)).
- A FormField showing a message (its own `issue` included) marks its control invalid in the server render too, `aria-invalid="true"` on a native field, so a refreshed form keeps the mark; `describeField` takes `invalid`, and a RowsField, Checkbox or Toggle in a static FormField is marked once the browser has it, as the choice groups are, and a RowsField now hands the app's own `ref` its group ([forms](../packages/ui/llms/forms.md), [describeField](islands-state-to-ids.md)).

## 1.97.0

- The 404 log forgets a path past 90 days on an hourly timer, and kayjs-cms sweeps expired drafts from the browser at load and hourly, not only when one is written ([privacy](privacy.md)).
- kayjs-mail's outbox page now streams through `eventStream`, exported from `kay/library` for libraries, so the stream is drained when the server stops ([event streams](api-from-islands.md)); kayjs-cms's editor learns that a saved change is live when the server is replaced by the rebuilt one, over a stream of the instance's id, and no longer reads the page every 4 seconds ([screens](../packages/cms/llms/screens-replacing.md)).
- kayjs-mail's outbox page now streams through `eventStream`, exported from `kay/library` for libraries, so the stream is drained when the server stops ([event streams](api-from-islands.md)); kayjs-cms's editor learns that a saved change is live when the server is replaced by the rebuilt one, over a stream of the instance's id, and reads the page at once then, besides a slow read every 15 to 30 seconds, instead of every 4 seconds ([screens](../packages/cms/llms/screens-replacing.md)).
- kayjs-cms adds a Revoke shared links button on an entry, which refuses every preview link already shared for it and is noted in the activity ([CMS history](../packages/cms/llms/history.md)).
- `preview.sharedNotBefore` in kay.config.ts (and `setSharedNotBefore` from `kay/server`) revokes an entry's share links: it answers the time before which no link of that entry is accepted, and an older link is refused as expired ([preview mode](content-preview.md)).
- kayjs-cms names more of its controls for assistive technology: the tables carry a hidden caption, a locked field's group a name, the Compare and Hide links the locale, the colour swatch its own name, "Add redirect" keeps its words first, and an alt-text or sign-in error is linked to its input; the new texts are the `cms.table.entries`, `cms.media.table`, `cms.uploads.table`, `cms.redirects.configured`, `cms.locales.compareAria`, `cms.locales.stopCompareAria` and `cms.field.colorPicker` wordings, and `cms.missing.addAria` now opens with "Add redirect".
- kayjs-ui: `Size` (`xs` to `lg`) is exported beside `Tone`, and every control's `size` prop is typed from it ([basics](../packages/ui/llms/basics.md)).
- kayjs-ui: Toaster and CommandPalette take `shortcut`, a full chord like SaveForm's, and `false` or `null` turns it off on all three; `hotkey` is deprecated, and `kay upgrade` rewrites it ([toasts](../packages/ui/llms/toasts.md), [upgrading](upgrading.md)).

- `announce(text, within?)` from `kay` is the one screen-reader announcer: a pending block, a page swap and kayjs-ui's `announce` (now this function) share one live region ([navigation](navigation.md)).

- A `role="group"` (ChipGroup, RangeInput, FileDrop, RowsField) is marked `data-invalid` in place of `aria-invalid`, which ARIA does not allow there; `focusInvalid` and `markInvalid` follow it ([navigation](navigation.md), [upgrading](upgrading.md)).

- kayjs-ui: IconPicker says how many icons a search found (`ui.iconPicker.results`), and a `Board` item moved by key into another container says its name (`ui.dnd.movedTo`) ([pickers](../packages/ui/llms/pickers.md), [drag and drop](../packages/ui/llms/charts-drag-and-media.md)).

- kayjs-ui: with several series, each series of a BarChart after the first is hatched in its own pattern, on its bars and in the legend, as LineChart dashes its lines ([charts](../packages/ui/llms/charts.md)).

- The checkbox of a Markdown task-list item with no text is `aria-hidden`, as nothing could name it ([content](content-markdown-to-caching.md)).

- kayjs-ui: a FormField around a FileDrop names, describes and marks the zone, not its hidden file input ([forms](../packages/ui/llms/forms.md)).

- kayjs-ui: the `text-2xs` size is 10px (it was 9.6px), so chart ticks, calendar weekdays, gallery counters and table cell labels stay readable ([restyle](../packages/ui/llms/restyle.md)).

- kayjs-ui: a HoverCard can be hovered, as its text can be read at length: it stays while the pointer is on it after the app cleared the anchor, and it no longer hides behind its own invisible anchor stand-in ([popovers](../packages/ui/llms/basics.md)).

- kayjs-ai: the chat's field is named `Message` (`fieldLabel`) apart from the log, the Allow and Deny buttons of a held tool call carry the tool's name and Allow takes focus, and starting a conversation over is said to screen readers (`startedLabel`) ([Chat](../packages/ai/llms/chat.md)).

- kayjs-ui: a required FormField shows the word `required` after the `*` (`ui.field.required`, French included), and a DateInput inside a FormField is named by the label text, not by its calendar button ([forms](../packages/ui/llms/forms-and-steps.md)); every literal `target="_blank"` link in kayjs-ui, kayjs-mail and kayjs-cms carries `data-new-tab`, so a screen reader hears it opens in a new tab.

- `typescript7` and `axe-core` are optional peers of kay, no longer installed in production: `kay new` adds both to `devDependencies`, a missing one stops `kay check`, `kay a11y` and the dev tool's checks with the `bun add -d` command to run, `kay doctor` has a `peers` check, and `kay upgrade` adds them to an existing app ([tools](check-and-tools.md), [upgrading](upgrading.md)).
- `kay build`, `routes`, `env`, `lint`, `types`, `doctor`, `i18n`, `not-found`, `a11y`, `screenshot` and `extensions` give up on a `kay.config.ts` that awaits something forever after 30 seconds, as `kay check` does, instead of hanging ([tools](check-and-tools.md)).
- `kay check` notes an entry shown on the site whose `reference()` names an entry held back as a draft or by `publishAt` and `unpublishAt`, as the `held-back-reference` lint, a warning ([lints](lints.md)).
- The SQLite `compose.prod.yaml` that `kay new` writes for an app on kayjs-auth passes `AUTH_DATABASE_URL` to the container, so the value `.env.example` lists reaches kayjs-auth ([scaffold](project-new-and-add.md)).
- `kay upgrade` warns when the git working tree holds uncommitted changes to tracked files, before it rewrites any ([tools](check-and-tools.md)).
- `kay add` and `kay generate` write each file atomically, keeping the mode of the one they replace, so a crash or a full disk leaves it as it was ([project and scaffolding](project-new-and-add.md)).
- The MCP `add` tool takes `install: true` with `apply: true`, which runs `bun add` and `bun install` so a library the project lacks (`auth`, `mail`, `cms`, `ai`, `ui`) can be added from an agent ([editor and agent commands](editor-and-agent-commands.md)).
- A hanging `onStop` hook is given up on after `serve.shutdownTimeout`, so the hooks after it and the stores' closing still run ([production](production.md)); the 404 log and redirects of a `pgData` store give up on a database call after 8 seconds, logged ([routing](routing-endpoints-and-base.md)); `keepalive` calls share the browser's 64 KB cap between them, the one past it going as a plain post ([actions from islands](actions-from-islands.md)).
- `kay check --fix` applies only fixes that keep behaviour: `island-prop`'s `--- island`, `unreachable-selector`'s `:global(...)` and an `old-bun-image` pinned by digest are offered, not applied. The `brace-in-attribute` fix reads the scope of the name, the missing-import fix finds the imports of a module from its syntax, two fixes at one place apply in a fixed order, and `deprecated-local-state` leaves a template's prose and names it binds itself alone ([checks](lints.md)).
- `kay mcp` refuses a `render` that POSTs and the `test` tool unless it was started with `--write`, as both run the app's code against its database, and `not_found` hands the paths visitors typed as data, cut at 120 characters ([MCP commands](editor-and-agent-commands.md)).
- A `workflow()` run writes each step's result once, as a row of its own beside its job, so a step costs the same in a run of 2,000 steps as in one of ten; runs kept before resume and move to rows at their next step ([queues](queues.md)).
- A queue keeps at most 2,000 characters of a failure's error, and a `workflow()` run fails with no retry once its kept results pass 2 MB, naming what to do ([queues](queues.md)).
- `kay new`'s test workflow runs on pull requests and on pushes to `main`, not twice for a pull request's commit, and the Forgejo Pages workflow's `SITE_URL` is `${{ vars.SITE_URL || github.server_url }}` in place of a `pages.example.com` placeholder ([project new and add](project-new-and-add.md)).
- `markdownHtml` (a user's Markdown, on the server and in an island) writes `loading="lazy"` on its images ([content](content.md)).
- kayjs-ai: an API root holding credentials in its URL (`https://user:pass@host`) is refused, naming the variable, as the key variables and options are where they go ([asking](../packages/ai/llms/asking.md)).
- kayjs-mail: the dev outbox file `.kay/mail-outbox.json` is written readable by its owner alone (0600) ([mail](../packages/mail/llms/contact-form-and-testing.md)).
- Links the libraries draw in a new tab by hand (kayjs-ui's subscribe form, app switcher and map attribution, kayjs-mail's, kayjs-auth's privacy link, kayjs-cms's) carry `rel="noopener noreferrer"`, as kayjs-ui's `OUTSIDE` does.
- kayjs-ui: `MapView` loads Leaflet once the map is near the viewport, so one below the fold downloads none of it until it is scrolled to ([charts and MapView](../packages/ui/llms/charts.md)).
- `/_kay/draft` answers 429 with `Retry-After` to an editor past 300 drafts a minute, and the browser error and CSP report routes answer 429 once all clients together pass 600 a minute, on top of each client's own limit ([edit mode](content-edit.md), [security](proxy-and-security.md)).

The rest of this release is in [What's new, older releases](whats-new-archive.md).

Releases before 1.97 are in [What's new, older releases](whats-new-archive.md).
