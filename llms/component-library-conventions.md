# Component libraries: conventions

## Common tasks

- Ship components, pages, tabs or commands from a package: the tasks of [Component libraries and extensions](component-libraries.md#common-tasks).

## Reference

### Conventions

How kay and its libraries name the same idea, written before the renames land: a new option, export, class or file follows the target form, and each `(#n)` is the issue moving the existing code to it. `tests/packages.test.ts` checks the prefixes, error class names and doc headings, listing the drift still waiting on its issue, so a new violation fails.

**Options**
- `site` is a public origin and defaults to kay's `site`; `name` is a display name. An option holding the site's own origin is spelled `site` (kayjs-auth's, the contact mail view's prop); `publicUrl` of `s3Files` and the `host` of an analytics provider hold another address (a bucket's, a provider's), so they keep their names. A third-party service's API root is `baseUrl`, not `url` (#1758).
- A duration is one `Duration` type, a string with its unit (`'250ms'`, `'5m'`), in every option, store argument and test helper of kay and the libraries: never a bare number, never a unit in a name (`timeoutMs`). The runtime still reads the old numbers until 1.73, and `kay check --fix` rewrites them (`deprecated-bare-duration`) (#1639).
- How long something stays valid is `maxAge`, how long to wait is `timeout`, an absolute date is `expires`; never `expiresIn` or `lifetime`, and a second lifetime is a nested `maxAge`, not `rememberMaxAge` (#1685).
- A size limit is `maxSize: ByteSize` (a number of bytes or `'2mb'`); `bodyLimit` and `maxBytes` go (#1686).
- A rate limit is `rateLimit: { max, window, store?, key?, count? }`, `key` naming who is counted (not `visitor`), and a library with several limits nests them: `rateLimit: { signIn: { max, window } }` (#1683).
- Paging by page number takes `pageSize` and `page`; a window onto a list takes `limit` and `offset`. An API is one or the other (#1689).
- Look goes in the library's settings module (`kay.settings`), behaviour in the call or extension options. A logo is `{ src, alt, width?, height?, href? }`, the `Logo` type of `kay/library`: mail and cms read theirs from the settings module, kayjs-ui and kayjs-auth have no logo of their own and kayjs-ai restyles through CSS properties (#1690).

**Hooks and switches**
- An `on*` hook takes one event object, `onSave({ ... })`, and returns nothing. A callback that returns data is named for what it returns (`profileFields`, `exportData`), not `on*` (#1694).
- A switch is `false` to turn off what is on by default and `true` to turn on what is off by default, with an object where it takes options; the default is the first line of its doc. `optional` on mail is reviewed against this (#1694).

**Errors**
- A boot-time config problem throws `KayError('config-invalid', 'kay: <option> is <value>; it takes <what>')`, in a library too, through `configError(option, value, takes)` from `kay/library`, or `configError(message)` for a problem of another shape; a reader that also runs in the browser throws a plain `Error` and its server caller wraps it in `asConfigError(() => ...)`.
- A runtime error class ends in `Error`, extends `Error`, and carries `code` (`AiError.kind` is also its `code`; an HTTP `status` stays beside it). A renamed export keeps its old name as an alias for three minors.

**Prefixes**
- Routes a library mounts for itself are `/_kay/<library>`, never under the app's `/api`; kayjs-cms's moved from `/api/cms/*` in 1.71, the old path answering three minors (`api.former`).
- CSS classes and ids are `k<library>-` (`kui-`, `kcms-`, `kai-`, `kauth-`, `kmail-`), kay's own `kay-`; a data attribute that names an element or marker is `data-k<library>-`, kay's `data-kay-`. A bare `data-tone` or `data-size` is the state of the component's own element (#1691).
- Cookies are `kay_<name>` and tables `kay_<plural name>` (kayjs-auth's moved from `auth_*` in 1.71, each table `renamedFrom` its old name for three minors); the default session cookie is `kay_session` with the old name not read, and a library cookie renamed is still read under its old name for three minors (kayjs-cms's `kay_editor_session`).
- An export name two libraries share is prefixed with its library (`authMemoryStore`), and a Postgres entry or helper is spelled `pg`, not `postgres` (#1692).

**Texts**
- A library looks text up with `wording('<library>.<area>.<name>', 'English')` from `kay/words`, ships a `fr.ts` and no `en.ts`, and registers its catalogs by `"kay": { "messages": "./src/messages" }` in package.json, never through an extension. Keys have no `Label` suffix. Props such as `*Label` stay as overrides (#1681, #1682); the suffix left on kayjs-ui and kayjs-cms keys goes in #1778.

**Docs**
- A topic file under `llms/` or a library's `llms/` opens with `## Common tasks` and holds `## Reference`. A library's `llms.txt` is a title, a one-line summary and links, like kay's, with no rules in it (#1693).

**Methods and props**
- A library's methods: `list<Things>()` for a collection, `get<Thing>(id)` for one, `revoke<Thing>` for a credential (a token, a session, a passkey), `delete<Thing>` for a record, and `{ ok }` as the result of anything that can be refused (#1688).
- kayjs-ui props: `variant`, `tone` and `size` are enums (no `solid` or `compact` booleans); `busy` shows a pending state; open state is `open` with `onOpenChange(open)`; `onSelect` gives the thing selected and its payload is documented; callbacks return `unknown`; `current` is `string | URL` everywhere (#1695).
- Results say `ok`, never `failed`, and `errors` hold messages the user can read (#1696).

**CLI and environment**
- A command that writes takes `--dry-run`; `--quiet` and `--format text|json` go to every command that prints; `-p` is `--project` alone; one spelling per flag, an alias kept three minors (#1696).
- `lang` is the language of a document, `locale` a language an app serves or formats for. Environment variables are the option's name in capitals, prefixed by the library (`AI_`, `MAIL_`), with `SITE_URL` for the origin (#1696).
