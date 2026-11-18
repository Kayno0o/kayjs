# Upgrading, older releases

What each minor release before 1.105 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

## 1.105.0 (continued)

### An island declares its settings with `island()`

`island({ render, hydrate, persist, interactive })` first in a component's script replaces the `--- island`, `--- client` and `--- static` fence lines and `export const island = { ... }` in a `--- module` fence: `--- client` is `island({ render: 'client' })`, `--- island` is `island()`, `--- static` is `island({ render: 'static' })`, and the export's `persist`, `hydrate` and `interactive` move into the call. On a use, `hydrate="client"` is `render="client"` and `server="defer"` is `server defer`. The old forms went in 1.109. kayjs-ui's `table.kay`, `site-nav.kay` and `app-header.kay` and kayjs-ai's `chat-launcher.kay` no longer export `island`: they declare it with the call, and an app reading that export reads the component's `interactive` props from its docs instead.

### `formatDuration` takes a duration with its unit

`formatDuration(7_500_000)` is `formatDuration('125m')` (or `'7500s'`, `'2.5h'`): a length is written with its unit everywhere in kay, as `formatBytes` already took bytes or `'1.5kb'`. A number of milliseconds still works until 1.108 and `kay upgrade` rewrites a literal one, as `'7500000ms'` (`deprecated-format-duration`); a number held in a variable is changed by hand, and the editor strikes the call through.

### An `img` takes its image options as attributes

`img({...image(hero, { aspect: '1/1', sizes: '100vw' })})` is `img(src={hero} aspect="1/1" sizes="100vw")`, `quality={90}` is the same for the quality, and `no-placeholder` is `placeholder={false}`. `image()` stays for an element that is no `img` and for an image kay did not import, which needs its `width` and `height` given to it. The old forms work until 1.108 and `kay upgrade` rewrites them (`deprecated-image-options`), a spread of `image()` only when it is the only one on the `img`, its `src` and its options are written in the call and a size is not among them; any other is changed by hand.

### A page's head, sitemap entry and cache are `seo` and `cache`

`noindex`, `sitemap`, `lastmod`, `search` and `feed` at the top level of `page` are the `seo` group, `export const page = { seo: { noindex: true } }`, and `ttl` and `cacheControl` are `cache`: `ttl: '1h'` is `cache: '1h'`, `cacheControl: false` is `cache: false`, and a header written out is `cache: { browser: '5m', shared: '1h', swr: '10m' }`, or `'private'`. The old keys work until 1.108 (`deprecated-page-seo`, `deprecated-page-cache`), and `kay upgrade` rewrites them where the new form is the same value: a page that has a `seo` or a `cache` already, a `ttl` beside a `cacheControl`, and a header text are left to you. `export const noindex = true` as an export of its own is a setting of `page` first (`deprecated-script-fence` does it), then of `seo`: run `kay upgrade` twice.

`seo` also takes `title`, `description`, `image` and `canonical`, and `head(title=... description=...)` takes them as attributes, so a page whose head has no tag of its own to write needs no `head` block.

### Server hooks that observe are `after<Verb>`

`deprecated-hook-names` finds the old names in the options of the call, in each collection of `cms({ collections })` and in the `hooks` of kayjs-auth's `src/auth.ts`: run `kay upgrade`. The old names work until 1.108, and the new one wins when both are written. `before<Verb>` (may refuse or change) and `onError`, `onEvent` and a queue's `onStart`, `onSuccess`, `onRetry` keep their names. Every hook already took one object with `context`.

- kayjs-auth: `onSignUp` is `afterSignUp`; its error source is `auth.afterSignUp`.
- kayjs-mail: `onSend` and `onSuppress` of `mailer()`, `onSend` of `contactForm()` are `afterSend` and `afterSuppress`; a list's `onSubscribe`, `onConfirm`, `onUnsubscribe` and `onBroadcast` are `afterSubscribe`, `afterConfirm`, `afterUnsubscribe` and `afterBroadcast`. Sources follow (`mail.afterSend`, `mail.list.afterSubscribe`).
- kayjs-cms: `onSave` and `onUpload` of `cms()` and of a collection are `afterSave` and `afterUpload` (sources `cms.afterSave`, `cms.afterUpload`).
- kayjs-ai: `onStep` and `onToolCall` are `afterStep` and `afterToolCall`, and `onSuccess` is `afterRequest`, beside `beforeRequest`, in `ai()` and in the options of `ask`, `speak`, `embed`, `transcribe` and `describeImage` (sources `ai.afterStep`, `ai.afterToolCall`, `ai.afterRequest`).
- A test or a log reading a hook's `source` from `observe.onError` reads the new name.


### Every job takes `(input, ctx)`, and `src/jobs` mounts them

`deprecated-job-handler`, `deprecated-schedule-call`, `deprecated-job-options` and `deprecated-disk-files` find the old forms: run `kay upgrade` on 1.105 and it rewrites each one written inline.

- A handler is `(input, ctx)` with `ctx.signal`, `ctx.job` (`{ id, attempts, progress }`), `ctx.log` and `ctx.locale`. A queue's `(payload, signal, job)` still runs until 1.108, `ctx` being its signal too; a workflow's `({ id, input, step })` is `(input, { step, job: { id } })`, `job.id` the run's id, and a schedule's or `background` job's `(signal)` is `(_, { signal })`, a schedule's first argument being `{ schedule, boot }`. A handler passed by name is not rewritten and no lint finds it: TypeScript does. The `WorkflowRun` type is `WorkflowContext`, and `JobContext` is the `ctx` of every job.
- `schedule('@hourly', job, options)` is `schedule({ cron: '@hourly', ...options }, job)`, `schedule('30s', job)` is `schedule({ every: '30s' }, job)`; the table form is unchanged. Both work until 1.108.
- `lostAfter` on `queue()` and `workflow()` is `timeout`, as a schedule's; `lostAfter` works until 1.108. `diskFiles('dir', hooks)` is `diskFiles({ dir, ...hooks })`.
- Queues, workflows and schedules move to `src/jobs/*.ts` when an app wants no `export default` and no `.use`; `src/plugins/jobs.ts` keeps working.

### Query params, persisted state, navigation and effects have one API each

Every old form below works until 1.108, `kay check` reports it as a `deprecated-*` warning, and `kay upgrade` rewrites it. The rewrite reads script fences and TypeScript files: a call written in a template expression, such as an `onClick` handler, stays and works.

- `persisted.query(name, value, options)` is `queryParam(name, { default: value, ...options })`, the one signal of a query param, which also takes `values` (`deprecated-persisted-query`).
- `persisted(name, value)` is `persisted.cookie(name, value)`: a call names its storage (`deprecated-persisted-call`).
- `navigate({ query: changes }, options)` is `navigate.query(changes, options)`: `navigate(href)` goes to a page, `navigate.query()` changes the query of this one (`deprecated-navigate-query`).
- `onNavigate(fn)` and `onBeforeNavigate(fn)` are `navigation.onNavigate(fn)` and `navigation.onBeforeNavigate(fn)`, the hooks of the source (`deprecated-navigation-hooks`).
- An island listening to `kay:navigate`, `kay:navigate-start`, `kay:navigate-error`, `kay:navigate-stall`, `kay:action-start`, `kay:action-success`, `kay:action-error`, `kay:consent` or `kay:install` with `listen` uses the function hook: `navigation.onNavigate`, `onStart`, `onError` and `onStall`, `add.onStart`, `onData` and `onError` of an action (`{ input }`, `{ error, input }`), the `consent` signal, `installPrompt.available()`. The events still fire for a plain script, and the old listener went on working: its lint went in 1.109.
- `listen(window, ...)` is `listen(() => window, ...)`: the target is one form, a function, and a value went in 1.109.
- `mount` and `Mounted` are imported from `kay`, not `kay/mount`; `s`, `RateLimit` and `RateLimitRefusal` from `kay`, not `kay/server`; `sqliteCache` from `kay/cache`, not `kay/server`; the old imports went in 1.109.

### The `storage` option of `persisted()` is gone

`persisted(name, value, { storage: 'local' })` is `persisted.local(name, value)`, `{ storage: 'query' }` is `queryParam(name, { default: value })` and `{ storage: 'cookie' }` is `persisted.cookie(name, value)`; `persisted.session()` keeps a value in sessionStorage. The option was deprecated in 1.101 and `deprecated-persisted-storage` goes with it: run `kay upgrade` on 1.104 first and it rewrites every one it can find. On 1.105 the types refuse the option (`PersistedOptions` is gone) and the runtime ignores it, and a call still passing it is reported by `deprecated-persisted-call` with no fix.
### cms access is one option

`cms({ access })` says who is let in: a kayjs-auth role or a list of them, `{ password }`, a function returning the person, or `false`; `guard`, `role` and `member` still work and are refused beside it. `deprecated-cms-options` (`kay check --fix`) rewrites `role` and `guard: passwordGuard(...)` and a list `uploads` to `uploads: { types }`; it works until 1.108.

- `cms({ role: 'editor' })` is `cms({ access: 'editor' })`, and `guard: passwordGuard(pw, opts)` is `access: { password: pw, ...opts }`.
- With `roles` listed and no `access`, `guard` or `role`, kayjs-auth admits their holders and refuses everyone else, edit links included, where the screens stayed closed before.
- `cms({ roles })` no longer needs a guard, and `can` no longer needs `roles`; with kayjs-auth and no `access`, the holders of the roles listed are let in, where the screens stayed closed before.
- A production server reads the forge from `CMS_URL` (`forgejo://TOKEN@git.example.com/owner/repo`, `github://TOKEN@owner/repo`, `gitlab://TOKEN@group/project`); `CMS_BASE_URL`, `CMS_REPO`, `CMS_TOKEN`, `CMS_BRANCH` and `CMS_HOST` still work without it, and `kay env` lists `CMS_URL`.
- The no-guard error and warning name `cms({ access })`, as do the `cms.*` message defaults that named `role` or `guard`.

### kayjs-mail: one way to send, the forms in kayjs-ui

- A page, an action or a guard sends through `ctx.locals.mail` (`send`, `enqueue`, `list`, `suppress`...), the mailer of the site answering the request; a job or a script uses the mailer `src/mail.ts` exports. `send` and `enqueue` imported from `@kayjs/mail` use the latest site started and work until 1.108 (`deprecated-mail-send`, no fix: a call has no request to read the mailer from), and `registeredMailer()` is gone: read `ctx.locals.mail`, or the mailer you made.
- `@kayjs/mail/subscribe-form.kay` is gone: import `SubscribeForm` from `@kayjs/ui/subscribe-form.kay`, which takes the same props and reads the list's `privacy` from the action. Its `kmail-subscribe*` classes are replaced by the themed form's own, and `kay upgrade` rewrites the import (`deprecated-mail-form`).
- `contactForm(options)` takes no mailer and sends through `ctx.locals.mail`; `contactForm(mail, options)` still works.
- `mailer()` and `mail()` take every `MAIL_*` setting as an option that wins over the variable: `url`, `smtp.insecure`, `smtp.rateLimit` and `smtp.dkim` join `from`, `to` and `events`. Nothing to change.
### kayjs-ai calls share one options type, and a chat takes `labels`

`kay upgrade` rewrites the forms it can find (`deprecated-ai-labels`, `deprecated-ai-language`, `deprecated-ai-links`); the old forms work until 1.108.

- `Chat`, `ChatLauncher` and `ChatPanel` take `labels={{ send: 'Go', stop: 'Halt' }}`, keyed as the messages are (`ai.chat.send`), in place of the `sendLabel` and `stopLabel` props; `waitingLabel` is `labels.thinking` and `failureLabel` `labels.error`. A flat prop still wins over `labels`.
- `Chat` takes `newTab` (`true`, `false` or `'auto'`, as kayjs-ui's links do) in place of `links`: `links="apart"` is `newTab={true}`, `links="here"` is `newTab="auto"`; `Sources` takes `newTab` in place of `here`. `ChatLauncher` takes `newTab` too, `'auto'` by default.
- The launcher's panel and button are kayjs-ui's `SidePanel` now, so a restyle of `@kayjs/ai/chat-panel.kay` changes: its parts `panel`, `button` and `glyph` are `root` and `launcher` of `'@kayjs/ui/side-panel.kay'` (the glyph is the button's icon), `head` and `title` are the same parts of `'@kayjs/ui/side-panel.kay'`, `body` is its `body`, and `actions` and `action` are gone: the header's buttons are the `new`, `expand` and `close` parts of `chat-panel.kay`. `kay check` already reports a part a component no longer has, listing the ones it has, which is why there is no lint for them. The `.kai-launcher` wrapper is no longer a fixed container and `.kai-launcher-panel` is a `dialog` that is `display: none` unless `[open]` (no `[hidden]`): a rule of an app's own on `.kai-launcher-head`, `-title`, `-actions`, `-glyph` or `.kai-launcher-panel[hidden]` moves to those parts and to `[open]`.
- `transcribe()` and `describeImage()` take `locale`, a BCP 47 tag, in place of `language`.
- `ask`, `describeImage`, `transcribe`, `speak` and `embed` take one `CallOptions`, so `retry`, `fallback`, `timeout`, `signal` and the `ai()` hooks reach each of them. `timeout` also takes a single duration for the whole call.

### kayjs-ui lists are `items`

The prop holding the list a component draws is `items` on every one: `tabs` on Tabs, `avatars` on AvatarGroup, `entries` on CommandPalette and Timeline, `links` on SideNav, SiteNav and AppHeader, `steps` on Steps, `icons` on IconPicker and `slides` on Carousel. The infinite `list` of Table, Carousel, Masonry, MediaGallery, VirtualList and LoadMore is `items` too (`items={feed}`, an `infiniteList`; on a Table `rows` stays the array and `items` the infinite source). `rows` of a Table and `options` of the choice controls keep their names, as do TabNav (its `tabs` and `links` are two shapes picked by `param`) and the `links` of a SideNav group. The old names work until 1.108, and `deprecated-ui-items` (`kay check --fix`) writes `items`; a template written under both reads `items`. Nothing else breaks: `label` on TextInput, Textarea, Select, DateInput, DateTimeInput, TimeInput, MarkdownEditor and FileDrop names the control (an `aria-label`, which still wins), Tabs takes `disabled` and TooltipHost `onOpenChange`.

### A control's `id`, `title` and `data-*` are its root's

Toggle, Checkbox, Slider, ColorInput, Combobox and DateInput put the attributes they are given that no control owns (`id`, `title`, `data-*`) on their root element, as every kayjs-ui component does; they reached the input before. The input takes `inputProps`, typed as an input's attributes: `Toggle(label="Alerts" inputProps={{ id: 'alerts' }})`. `name`, `disabled`, `required`, `value`, `aria-*`, `data-tooltip`, `ref` and the `on*` handlers still reach the input. `deprecated-ui-input` (`kay check --fix`) writes the `id`, `title` and `data-*` of a component in a template into `inputProps`, which keeps the old markup; a Combobox's `id`, the list's, stays. Something that reads the input through the `id` of a spread (a stylesheet, a script, a `label(for)`) needs the `inputProps` form, or the root's `id`.

### SidePanel is a Dialog with a side `placement`

`SidePanel` draws a `Dialog` with `placement="right"`, so the head, title, body and footer are the Dialog's. Nothing changes in its props, and its `parts` still take `head`, `title`, `body` and `footer`, handed to the Dialog. A `src/ui.ts` entry for `'@kayjs/ui/side-panel.kay'` with `head`, `title`, `body` or `footer` moves to `'@kayjs/ui/dialog.kay'` (which then restyles centred dialogs too: a part restyled for one placement only is `class` on the call); `kay check` reports the entry left behind, as a part the component no longer has.

### A page is never an island

A page without a `--- server` fence that has an `on*`, `bind:` or `ref`, a browser value of `kay` such as `signal`, or a live or persisted import used to become an island. It still does through 1.107, and 1.109 refuses it with `page-island`. Move what needs the browser into a component of its own and render it from the page: the component is the island. No `kay upgrade` fix exists, as the fix moves code into a new file.

Releases before 1.105 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.

### Island sources read and report the same way

every source (`resource`, `stream`, `socket`, `local`, a `track()` handle) has `data()`, `status()`, `pending()`, `error()` and `retry()`, and `onData({ value })` and `onError`. `value()`, `last()`, `rows()`, `unsynced()`, `syncStatus()`, `onSuccess`, `onSync` and an action's `succeeded()` work through 1.107, and `kay check` warns with `deprecated-source-readers` and `kay upgrade` rewrites them.

An action has `data()` and `status()` too, and `succeeded()` is `data()` (what the last call returned, `status() === 'ready'` for whether there was one); an action has no `retry()`, `onData` or `onError` of its own, its `track()` handle does.

Not rewritten, so by hand: `pending()` and `status()` of a `local()` collection keep their names and change meaning, so no check can tell an old read from a new one: they read a boolean and `idle|loading|ready|failed`, not the count and the sync states, and `{todos.pending()}` renders `true` or `false` now. Write `sync.queued()` and `sync.status()` for the old reads, and `ReturnType<LocalSync['status']>` where the type `LocalStatus` was used (it is gone). `rows()` of an `infiniteList()` and `last()` of the stream an action's island call returns are `data()`, with no lint, as `kay check` does not follow an import of kayjs-ui nor the receiver of an awaited call. A custom list given to `LoadMore` or `Table` takes `data()` beside `rows()` (a list with only `rows()` still works through 1.107), and a fake stream in a test needs `data`. `succeeded()` read as a whole (passed on, or `succeeded()?.data?.id`) becomes `data()` with `status() === 'ready'` where it tested for a result. An event's `data` and `rows` in a handler passed by name are `value` now.
### Live values and presence write alike

`set` of a live value takes the next value first and where it goes in its options: `room.set(next, { key: id })` of a value per key, `unread.set(next, { user: id })` of a value per user, and `visitors.set(next)` as before. `presence({ room, member })` takes one object, in place of `presence(room, member)`. The old forms work until 1.108, `kay check` warns with `deprecated-live-api` and `kay upgrade` rewrites them, on a value declared in the file with `live()` or imported under a name every declaration of the project agrees on; a value reached through a namespace import is not found. A `set(key, next)` whose `next` is an object holding only `key` (or `user`) reads as the new form, so write it in the new order.

### One Action type crosses into components

`Action` with no parameters takes any action as a prop, in place of `Action<never, unknown>`: the old spelling works until 1.108 and `deprecated-action-type` rewrites it. A `.with()` action now crosses into an island, its fields sent over the input of each call, where it failed the render; `NoInputAction` stays.

### Component callbacks take one event object

Every transition callback of a kayjs-ui, kayjs-ai or kayjs-cms component takes one object holding what it reports, never positional arguments or a bare value: `onOpenChange(true)` is `onOpenChange({ open })`, `onChange(value, option)` is `onChange({ value, option })`. A handler written by hand destructures the event, `onChange={({ value }) => kind = value}` in place of `onChange={kind.set}`; `kay check` types it, so a handler reading the old arguments fails the check. The fields are in [the conventions](component-library-conventions.md) and each component's page: `open`, `value`, `checked` (Checkbox, Toggle, Menu), `rows`, `files`, `item` (`onSelect`), `page`, `size`, `sort`, `row`, `index`, `text`, `data` (`onSave`, `onSend`), `audio`, `crop`, `from` and `to`. A source reports `onLoad({ options, query })`, `{ rows }` on Table and `{ items }` on VirtualList. `onSelectedChange` is `{ keys, rows }` on Table, `{ id, node }` on TreeView and `{ key, entry }` on Timeline, so `bind:selected` no longer applies to them. `onError`, the callbacks with no argument and Chat's `onSend({ messages })` are unchanged.

Four callbacks are renamed to say what they report, and the old names keep working with their positional arguments until 1.108: `onChange` of Accordion, Tabs and ThemeToggle is `onValueChange`, ZoomPane's is `onPlateChange({ plate })`, Table's `onSort` is `onSortChange({ sort })` and a chart's `onActive` is `onActiveChange({ index })`. `kay check` reports them as `deprecated-ui-callbacks` and `kay upgrade` rewrites an inline arrow function, any other value getting the new name only.

