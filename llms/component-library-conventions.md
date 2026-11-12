# Component libraries: conventions

## Common tasks

- Ship components, pages, tabs or commands from a package: the tasks of [Component libraries and extensions](component-libraries.md#common-tasks).

## Reference

### Conventions

How kay and its libraries name the same idea, written before the renames land: a new option, export, class or file follows the target form, and each `(#n)` is the issue moving the existing code to it. `tests/packages.test.ts` checks the prefixes, error class names and doc headings, listing the drift still waiting on its issue, so a new violation fails.

**Options**
- `site` is a public origin and defaults to kay's `site`; `name` is a display name. An option holding the site's own origin is spelled `site` (kayjs-auth's, the contact mail view's prop); `publicUrl` of `s3Files` and the `host` of an analytics provider hold another address (a bucket's, a provider's), so they keep their names. A third-party service's API root is `baseUrl`, not `url` (#1758).
- A duration is one `Duration` type, a string with its unit (`'250ms'`, `'5m'`), in every option, store argument and test helper of kay and the libraries: never a bare number, never a unit in a name (`timeoutMs`) (#1639).
- How long something stays valid is `maxAge`, how long to wait is `timeout`, an absolute date is `expires`; never `expiresIn` or `lifetime`, and a second lifetime is a nested `maxAge` (#1685).
- A size limit is `maxSize: ByteSize` (a number of bytes or `'2mb'`) (#1686), never `maxFileSize` or `maxAttachmentBytes`; a map of limits by path is `maxSizeByPath` (#2963).
- A rate limit is `rateLimit: { max, window, store?, key?, count? }`, `key` naming who is counted (not `visitor`), and a library with several limits nests them: `rateLimit: { signIn: { max, window } }` (#1683).
- What an option lists or tests to keep or leave out is `include` and `exclude`, never `hide`, `only`, `ignore` or `skip`: a list of names or paths, or a predicate where the rule is code. The shape follows what the value holds: an unnamed list of items is an array, a keyed set a record, and a switch that also takes options `true | Options` (so not `string[] | Options`). `analytics({ exclude })` and the form layout's `exclude` of kayjs-cms are the model. What is not a filter keeps its word: a hook that admits an action (`allow`, `authorize`), a record of reasons by action (`denied`), a single target (`to`, `except` of `rooms.publish`).
- Paging by page number takes `pageSize` and `page`, and its result reports `page`, `pages` and, when it counts the rows, `total`; a window onto a list takes `limit` and `offset` (`infiniteList({ limit })`, `pageFields()`, `store.list`, `entries()`). An API is one or the other (#1689, #2972). A list result that reports how many rows exist calls it `total` (`pageOf`, `ListUsersResult`, a CMS `ListScreen`, `CollectionInfo`), never `count` or `totalCount`; an option asking for it is `total: true`. A cursor is for an API that truly pages by one, named `cursor` or `before`, and says so: the auth audit log's `AuditCursor`. An app wiring `infiniteList`, `Pagination` and `paginate` writes the same words in each: `limit` and `offset` out of the browser's window, `page`, `pages` and `pageSize` for numbered pages, `total` for the rows.
- Look goes in the library's settings module (`kay.settings`), behaviour in the call or extension options. A logo is `{ src, alt, width?, height?, href? }`, the `Logo` type of `kay/library`: mail and cms read theirs from the settings module, kayjs-ui and kayjs-auth have no logo of their own and kayjs-ai restyles through CSS properties (#1690).

**Times**
- A record or event an app reads carries its times as `Date`: `null` when absent on a stored row, optional on an event. Epoch milliseconds belong to store interfaces (what a `*Store` keeps or returns), never to a record an app reads: a `Date` crosses to an island as a `Date` (#3000).
- A time is named `<verb>At` (`createdAt`, `sentAt`, `suppressedAt`) and its end `expiresAt`, never bare `at`, `modified`, `date` or `expires`. What a person wrote keeps its name: a front-matter `date`, a feed item's `date`, an email's `Date` header.
- A record a store keeps or lists is the store's own type in milliseconds, named for the store (`StoredNotification`, `NotificationRow`, `StoredSuppression`, `ConversationRow`), and the type an app reads is the same fields with `Date`. The job, rate-limit, cache and list-store records (`StoredJob`, `RateWindow`, `StoredValue`, `Subscriber`, `Broadcast`) are store types and keep milliseconds. The dev tool's log lines carry `time: string` for display.

**Hooks and switches**
- An `on*` hook of a server extension takes one event object, `onSave({ ... })`, and returns nothing; the `on*` prop of a kayjs-ui component takes the transition's value directly (`onSave(result)`, `onSend(data)`, `onCopy(text)`), as the DOM does, except `onError({ error })` ([hooks](hooks.md)). A callback that returns data is named for what it returns (`profileFields`, `exportData`), not `on*` (#1694).
- A switch is `false` to turn off what is on by default and `true` to turn on what is off by default, with an object where it takes options; the default is the first line of its doc. `optional` on mail is reviewed against this (#1694).

**Errors**
- A boot-time config problem throws `KayError('config-invalid', 'kay: <option> is <value>; it takes <what>')`, in a library too, through `configError(library, option, message)` from `kay/library` (`configError('cms', 'pageSize', message)`), whose message ends on `(kayjs-cms option `pageSize`: kayjs-cms/llms.txt)`, so the option must be written between backticks in the library's `llms/` (`tests/packages.test.ts` fails for one that is not); the older `configError(option, value, takes)` and `configError(message)` still work for kay's own code and an app; a reader that also runs in the browser throws a plain `Error` and its server caller wraps it in `asConfigError(() => ...)`.
- A runtime error class ends in `Error`, extends `Error`, and carries `code` (`AiError.kind` is also its `code`; an HTTP `status` stays beside it).

**Prefixes**
- Routes a library mounts for itself are `/_kay/<library>`, never under the app's `/api`; kayjs-cms's moved from `/api/cms/*` in 1.71 (`api.former` stays for a library moving its own).
- CSS classes and ids are `k<library>-` (`kui-`, `kcms-`, `kai-`, `kauth-`, `kmail-`), kay's own `kay-`; a data attribute that names an element or marker is `data-k<library>-`, kay's `data-kay-`. A bare `data-tone` or `data-size` is the state of the component's own element (#1691).
- Cookies are `kay_<name>` and tables `kay_<plural name>` (kayjs-auth's moved from `auth_*` in 1.71 and keep the `renamedFrom` of the old names, absent only on 1.74 to 1.76); the default session cookie is `kay_session` with the old name not read, and a library cookie renamed is still read under its old name for three minors.
- An export name two libraries share is prefixed with its library (`authGuard`), and a Postgres entry or helper is spelled `pg`, not `postgres` (#1692).

**Names**
- A constructor or entry point is a noun for what it holds or returns, `queue()`, `rooms()`, `sqliteData()`, `memorySessions()`; a store starts with its technology, `memoryAuth()`, `pgAuth()`, `pgLoader()`. Where a bare noun is another export's or a common local name, the library prefix is added (`authGate`, `authCore`, `cmsDrafts`, `cmsEntryForm`). The extension of a package is its name, `auth()`, `cms()`, `mail()`, `ai()` from the package root and `ui()` too (`@kaynooo/kayjs-ui/extension` stays as an alias); `mail()` is the extension, `mailer()` the client (#2978).
- `create*` is kept for a helper that writes schema, in one scheme: `createXTables(source)` creates, `xTableNames` lists the names for pg-orm's `ignoreTables`, `xTables` is the pg-orm definitions (`createJobTables`, `jobTableNames`; `createMailListTables`, `mailListTableNames`; `authTables`). `createContext` and the reactive primitives follow the framework's own convention (#2950).
- A Postgres store or table helper takes a `PgSource` from `kay/library`, a Bun `SQL`, a pg-orm `Database` or a URL, as its argument or under the key `source` (`pgLoader({ name, source })`). `pgAuth(db)` runs on pg-orm repositories, so it takes a `Database` alone; a URL goes to `auth({ store: { url } })` (#2950).

**Texts**
- A library looks text up with `wording('<library>.<area>.<name>', 'English')` from `kay/words`, ships a `fr.ts` and no `en.ts`, and registers its catalogs by `"kay": { "messages": "./src/messages" }` in package.json, never through an extension. Keys have no `Label` suffix. Props such as `*Label` stay as overrides (#1681, #1682); the suffix left on kayjs-ui and kayjs-cms keys goes in #1778.

**Docs**
- A topic file under `llms/` or a library's `llms/` opens with `## Common tasks` and holds `## Reference`. A library's `llms.txt` is a title, a one-line summary and links, like kay's, with no rules in it (#1693).

**Methods and props**
- A library's methods: `list<Things>()` for a collection, `get<Thing>(id)` for one, `revoke<Thing>` for a credential (a token, a session, a passkey), `delete<Thing>` for a record, and `{ ok }` as the result of anything that can be refused (#1688).
- kayjs-ui props: `variant`, `tone` and `size` are enums (no `solid` or `compact` booleans); `busy` shows a pending state; open state is `open` with `onOpenChange(open)`; state a prop can hold reports through `on<Prop>Change` (`onSelectedChange` for `selected`), a press of an item is `onSelect` and its payload is documented (#2852); callbacks return `unknown`; `current` is `string | URL` everywhere (#1695).
- Results say `ok`, never `failed`, and `errors` hold messages the user can read (#1696).

**CLI and environment**
- A command that writes takes `--dry-run`; `--quiet` and `--format text|json` go to every command that prints; `-p` is `--project` alone; one spelling per flag, an alias kept three minors (#1696).
- `lang` is the language of a document, `locale` a language an app serves or formats for. Environment variables are the option's name in capitals, prefixed by the library (`AI_`, `MAIL_`), with `SITE_URL` for the origin (#1696).
