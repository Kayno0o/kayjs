# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.87.0

### `ActionError`, `ActionRedirectError`, `ApiError`, `apiUrl`, `publicEnv` and `defineUi` no longer make a component an island

- A component whose only value from `kay` is one of these is static now and ships no JavaScript: it loses its island chunk.
- It renders without the `<slot data-component ...>` an island sits in, so a selector relying on that element (`>`, `+`, `:first-child`, `:nth-child`) sees one element fewer: re-check them.
- `hydrate` and `persist` are island options: a parent passing them to such a component drops them, and `kay check` reports a leftover one as a type error on a component that declares props (one that declares none takes any attribute).
- No lint can recognise it: the change is in what the compiler decides for a component, not in a form an app writes, so there is no old syntax for a `deprecated` lint to find and fix.
- `kay explain island` and `kay build --format json` show the role of each component.
### One vocabulary for the sources an island reads

- `StreamStatus`, `ResourceStatus` and `ResourceFailure` from `kay` are `ConnectionStatus`, `LoadStatus` and `ApiError` (`kay upgrade` renames them, the old names work until 1.90). A socket the server closes with a code from 4000 to 4999 is now `failed` (its `error().status` the code minus 4000) instead of reconnecting: an app that closes with such a code and expects the client to retry must close with another code. An exhaustive `switch` over `SocketStatus` needs a `failed` case, and `resource().error()` is an `ApiError`, so `toEqual({ status, message })` on it becomes `toMatchObject`.

### A page at a collection's route prerenders

- A page whose pattern is a collection's `route` (`src/routes/blog/[slug].kay` for `/blog/:slug`) is prerendered and listed in the sitemap for each of the collection's entries, as `prerender: posts` did, with no `page` export. One that was rendered per request and reads the cookies, the query, a session or preview mode now fails `kay build`: set `export const page = { prerender: false }` in it. A page that sets `prerender` keeps what it says. `kay check` cannot tell a page reading the request from one that does not, so no lint ships with this.

### `url` as a function and a feed item's `path` beside a `route`

- A collection with a literal `route` writes no `url` function, as its entries' `url` comes from the route, and a feed's `item` leaves out `path` when it is that route with the slug. Both forms keep working until 1.90, reported by the `deprecated-collection-links` lint, which `kay upgrade` fixes.

### kayjs-ui: `size` on a field is its own

- TextInput, Select, Combobox, DateInput and the other field controls take `size` as `sm`, `md` or `lg`, so the native `size` attribute (an input's character width, a select's row count) is no longer passed through: set the width with CSS (`w-48`).

### kayjs-ui: one `Tone` for every component

- `SparkTone`, and the `tone` of a `TimelineEntry`, a Sparkline bar and a StatusStrip cell, name the quiet grey `neutral` instead of `muted`: change `tone: 'muted'` to `'neutral'`. `SparkTone` is deprecated for `Tone` and goes in 2.0.0.
- A Notice's `info` tone is now drawn in `--color-info` and its default tone is `neutral`, which keeps the look `info` had: pass `tone="info"` only for the coloured one. It writes `data-tone="neutral"` where it wrote `info`, so a `defineUi` restyle or a `[data-tone=info]` rule of an app no longer reaches a default Notice: target `neutral`, or pass `tone="info"`.

### kayjs-ui: `onSelectedChange` on Table, TreeView and Timeline

- `onSelect` on a `Table`, `TreeView` or `Timeline` is `onSelectedChange`, the `on<Prop>Change` of their `selected`; `onSelect` stays the press of an item on BarList, the charts, Steps and Menu. The old name still works until 1.90: `kay check` reports it as `deprecated-ui-callbacks` and `kay upgrade` renames it in `.kay` files.

### kayjs-ui: Dialog and SidePanel share a head line

- A Dialog now draws a close button in its head line, so positional `button` selectors in an app's tests shift: pick the footer's buttons by `[data-part=footer] button` or by name. Its `title` part lost its border and padding to the new `head` part, so a restyle of `title` that set them is set on `head` now. A SidePanel closes no more on a click outside once something was typed inside, as a Dialog does (`dirty` locks it too), and `onInput` is no longer one of its props.

### kayjs-auth: the account, provider and audit methods are grouped

- `auth.deleteAccount(proof)`, `auth.listAuditLog()` and the other flat account, provider and audit methods are `auth.account.delete(proof)`, `auth.audit.list()` and so on, and `createUser` on the `createAuth` result is `admin.createUser` ([the table](../packages/auth/llms/grouped-methods.md)). The flat names work until 1.90; `kay upgrade` renames the calls (`deprecated-auth-account-methods`).

### kayjs-auth: breached passwords are checked in production

- `breachedPasswords` defaults to on when `NODE_ENV` is `production`: `password.register`, `password.reset`, `password.change` and `createUser` ask Have I Been Pwned (the first five characters of the SHA-1 only; an outage lets the password through) and refuse a listed one as `errors.password: 'breached'`. An app that must not call the service sets `breachedPasswords: false`; a test running with `NODE_ENV=production` stubs `fetch` or sets it.
- In production `createAuth` warns when password sign-up is open with no `email` option, as registering then answers `taken` for a held address. No lint recognises it.

### Every failure carries `status`, `message`, `errors` and `data`

- `ApiError.answer` is `data`, and `ApiError` gains `errors`; an `ActionError`'s `answer` stays its response body text, now named `body`. Both old names work until 1.90. `kay upgrade` renames a read inside `if (x instanceof ActionError)` (or the right side of an `&&`) to `.body`; a read narrowed to `ApiError` gets a `.data` fix that `kay upgrade` does not apply, as the receiver may be an `ActionError`; a receiver only a `catch` or a cast says is an error is reported with no fix (`deprecated-api-error-answer`).
- `refusalMessage(error, fallback)` is deprecated: an `ApiError`'s `message` is always safe to show, a status 0 one reading `The server could not be reached` with the browser's error as `cause`. `kay check` offers `error instanceof ApiError && error.status !== 0 ? error.message : fallback` but `kay upgrade` does not apply it, as an `ActionError`'s message now also reads its field messages and `data.message` where `refusalMessage` gave the fallback (`deprecated-refusal-message`).
- The failed branch of a `track()` result, `FormFailure` and `LocalIssue` gain `message`; an object built by hand to satisfy one of these types needs the field. A route's refusal now reads its `message` as `errors['']`, else the field messages, else `data.message`, else the text it answered.
### `fileStore` is `store.files`

- `fileStore: x` in `kay.config.ts` (and in `pages()`, `testSite()` and an extension's `config`) is `store: { files: x }`: it works until 1.90, `kay check` reports it as `deprecated-file-store` and `kay upgrade` moves it, unless the object has a `store` already, where `files` goes into it by hand. `sqliteData` and `pgData` leave files where they are: `store.files` is only what an app writes, and `fileStore` wins while both are written.

## 1.86.0

### kayjs-auth: the flat methods are gone

- The flat `Auth` methods deprecated in 1.82 (`auth.listUsers()`, `auth.signInWithPassword(input)`, `auth.invite(ref, email)`) no longer exist, and the `deprecated-auth-methods` lint goes with them; `missing-captcha` reads the grouped calls only. Call the grouped method ([the table](../packages/auth/llms/grouped-methods.md)): an app still on a flat name upgrades to 1.85 first, where `kay upgrade` renames the calls, then to 1.86.

### The prebuilt auth pages write a main landmark

- The sign-in, register, reset, two-factor, verify, confirm, magic-link, invitation and OAuth pages and the account and admin layouts now write their content in a `main`. An app whose layout already wraps pages in a `main` sets `auth({ pages: { main: false } })` (or `createAuth`) once, and the pages write a `div` instead: left as it is, the page holds two `main` landmarks. No lint recognises it, so none ships with this change.

### A usage error exits 2

- A command line `kay` cannot take (an unknown command, an unknown option, an argument too many or missing, a `refuse(reason)` of an extension command) exits 2 and prints `error: kay <command>: <reason>` with a `hint:` line, where it exited 1 and printed the reason and the usage. A script or CI step testing for exit 1 on a bad command line tests for 2; a command that ran and failed still exits 1. `kay <command> --help` prints the options with a line each after the usage, and `kay i18n` alone, a group with no command named, is the same error, `kay i18n --help` lists the group. No lint recognises a command line, so none ships with this.
- An extension command that begins with the words of another extension's (`db` and `db migrate`) stops the command, as the shorter would be a group of the longer: rename one.

### A module a mounted component imports is the test's own instance

- `mountComponent` no longer runs the project's modules afresh on every mount: a module of the project or a package, a signal store or a `persisted()` signal declared in a module included, is the one the test imports, so its state carries over to the next mount and test. A test that relied on a store starting empty resets it in `afterEach` (`count.set(0)`), and one that wrote `writePersisted` before each mount of a module-level `persisted()` sets the signal instead after the first. A signal declared in the component's own `.kay` file starts fresh as before. `kay check` cannot recognise a test, so there is no deprecated lint.

## 1.85.0

### kayjs-ui's `LineChart` needs chartist 2.2

- The `chartist` peer is `^2.2.0` (was `^2.0.0`): `bun update chartist` before upgrading kayjs-ui. `kay check` cannot recognise a chartist version, so there is no deprecated lint.

### kayjs-auth reads no `attempts` counter

- The `attempts` counter a store gave before 1.81 is no longer read, and `deprecated-auth-attempts` is gone with it: a store literal typed `AuthStore` still holding one gets a type error from `kay check`. Drop it, attempts then counting in the app's `store.rates`, else in memory, or give `rates`, a kay `RateStore` with `peek` and `reset` over the store's own database. `kay upgrade` on 1.84 drops `attempts: memoryAuthStore().attempts`.

## 1.84.0

### kayjs-ui's `LineChart` needs chartist 2

- The `chartist` peer is `^2.0.0` (was `^1.5.0`): `bun add chartist@^2` before upgrading kayjs-ui. `LineChart` draws through chartist 2's `lineChart()` with `chartist/compat`, which 1.x has not, so 1.x no longer works.
- A `LineChart`'s `options` prop is chartist's `LineChartPresetOptions`: the 1.x options, plus `plugins`, `layers` and axis factories. An `options.axisX.type: FixedScaleAxis` (the 1.x class) still works, and `fixedScaleAxis()` replaces it. `kay check` cannot recognise a chartist version, so there is no deprecated lint.

### A kayjs-ui `Rating` needs its `label`

- `Rating(value={4.6})` fails `kay check`: give it the text screen readers read, as `Meter` and `Progress` already need, `Rating(value={4.6} label="Rated 4.6 out of 5")`. The `ui.rating.label` message (`{value} out of {max}`) that stood in for a missing one is gone.

### kayjs-ui: `Meter`'s `fillClass` is deprecated

- `Meter(fillClass="bg-warning")` becomes `Meter(class={{ fill: 'bg-warning' }})`, which replaces the fill's accent the same way. `fillClass` still works until 2.0.0 (`@deprecated`). No lint carries it: `kay check` does not resolve a library component's props in a template.

### kayjs-ui: `MenuAction.danger` and `Toast.type` are deprecated

- A `MenuAction` with `danger: true` becomes `tone: 'danger'`, which wins when both are given. Both still work until 2.0.0, and the editor strikes them out (`@deprecated`).
- A read of `toasts()[n].type`, or of the `ToastType` type, becomes `tone`, where the old `'error'` is `'danger'`. 2.0.0 makes a toast `{ id, message, tone }`; `toast.error()` stays the method for a failure and pushes a `danger` toast.

### kayjs-ai: a key over plain http, and `AI_PROVIDER=openai` without a key

- A key sent to a plain `http://` API root that is not loopback, such as `AI_BASE_URL=http://ollama:11434/v1` on a compose network with `OPENAI_API_KEY` set, now throws until `AI_INSECURE=true` (or `insecure: true` on `openai()` and `anthropic()`) says the network is trusted; `https://` and `localhost` are unchanged, and a root with no scheme throws naming its variable.
- `AI_PROVIDER=openai` without `OPENAI_API_KEY` throws unless `AI_BASE_URL` names a server. `kay check` cannot recognise either, as both depend on the environment, so there is no deprecated lint.

### A string field of an action is bounded to 10,000 characters

- A string field of an action's schema with no `maxLength` is now refused past 10,000 characters: declare a `maxLength` on a field that takes more, a long text or a pasted document say. `unbounded-string` is a warning now, so a `// kay-allow` or a level it was given stays valid.
- A string in the `body` of an API route (a websocket's messages excepted) takes the same bound: declare a `maxLength` on one that takes more.

### The `island-action` lint is gone

- An island no longer needs `Action` imported to be handed an action, so `island-action` is removed: delete a `// kay-allow island-action` comment or a `lints` entry naming it, which `kay check` now reports as an unknown lint; no `deprecated` lint announces it, as an island still importing `Action` compiles and works as before. `island()` and `promote()` from `kay/island`, which compiled components call, lose their trailing `takesActions` argument, and the `PlainIslandProp` type lets an island's prop hold an action without a type for it.

### The session stores are `memorySessions` and `sqliteSessions`

- `memoryStore()` and `sqliteStore(path)` of `kay/server` are `memorySessions()` and `sqliteSessions(path)`, named for what they hold like `memoryJobs` and `sqliteRates`. The old names still work until 1.87; `kay upgrade` renames the imports and their uses (`deprecated-session-stores`).

### kayjs-auth: `safeRedirect` is kay's `localPath`

- `safeRedirect(path, fallback?)` of kayjs-auth is `localPath(path, fallback)` from `kay`, with `'/'` as the fallback `safeRedirect` defaulted to. It works until 1.87; `kay upgrade` rewrites the calls and the import (`deprecated-safe-redirect`), a fallback that is no string literal or a `safeRedirect` read as a value by hand.

### `session.settings` holds durations

- `session.settings.maxAge`, `absoluteMaxAge` and `browserMaxAge` are durations in whole seconds such as `'2592000s'`, where they were bare numbers of seconds. Code reading one as a number gets a type error from `kay check`; `durationMs(settings.maxAge)` from `kay` gives milliseconds. No `deprecated` lint can carry a type change.

### A session sealed before kay 1.72.0 signs its visitor out once

- `session()` opens a cookie with the key derived for it only, no longer with the bare SHA-256 of the secret that kay sealed under before v1.72.0. A visitor whose cookie was last written by such a kay, and never since by a later one, is signed out once. Nothing changes in the app, and no lint can carry it as it is cookie data.

### A misspelled config key is refused

- A key kay does not know in `kay.config.ts` (or in an extension's `config`), at its top level or in `security`, `i18n`, `seo`, `offline`, `health` and `proxy`, now stops every command with the nearest known name, where it used to leave kay's default in place. An app whose config already carries a typo starts failing: correct the key, or drop it.

### Config keys are named by what they hold

- `routes`, `api`, `content`, `storage`, `maxSizes` and `settings` in `kay.config.ts`, in the options of `pages()` and `testSite()` and in an extension's `config`, are `routesDir`, `apiDir`, `contentConfig`, `fileStore`, `maxSizeByPath` and `librarySettings`: a key naming a directory ends in `Dir`, one naming a file or module is `...Config`, and no two keys are a letter apart. The old names work until 1.87 and `kay check` reports them as `deprecated-config-keys`; `kay upgrade` renames them.

## 1.82.0

### An `ActionStream` has `ended()`

- An object the app builds as an `ActionStream`, a test's fake stream say, gets a type error from `kay check` until it has `ended: () => Promise<T | undefined>`, resolving with its last value once it ran to its end and rejecting when it failed or was closed ([streaming actions](actions-from-islands.md)). A stream a call resolves with already has it.

### kayjs-auth: the methods of a feature are grouped under it

- `auth.listUsers()` is `auth.admin.listUsers()`, `auth.signInWithPassword(input)` is `auth.password.signIn(input)`, and so on for `password`, `email`, `magicLink`, `twoFactor`, `passkeys`, `sessions`, `tokens`, `oauthServer`, `admin` and `organizations` ([the table](../packages/auth/llms/grouped-methods.md)). The flat names work until 1.85 and are removed in 1.86; `kay upgrade` renames the calls on `auth` and `ctx.locals.auth` (`deprecated-auth-methods`), and a flat method read without a call, destructured, under `typeof` or in a template expression is renamed by hand.

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

Releases before 1.76 are in [Upgrading, older releases](upgrading-archive.md).
