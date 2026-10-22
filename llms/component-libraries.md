# Component libraries and extensions

## Common tasks

### Ship components in a package

Ship the `.kay` sources, list `kay` under `peerDependencies`, and give each component a specifier; the app installing it compiles them as its own:

```json
{
  "name": "my-ui",
  "exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" },
  "kay": { "settings": "./src/settings.ts" }
}
```

### Add pages to the app from a library

The library hands the app one value to list in `extensions`, see [Extensions](#extensions):

```ts
// The app's kay.config.ts
import { auth } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [auth()] })
```

## Reference

### Publishing a component library

A package can ship `.kay` components, which the app installing it compiles as its own: on the server, in islands, and in `kay build --compile` and `--static`.

- Ship the `.kay` sources, list `kay` under `peerDependencies`, and import from `kay`, so the app's one copy of kay, and its registered types, serve the library too.
- Give each component a specifier in the exports map, `"exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" }`, imported as `import Button from '@kaynooo/kayjs-ui/button.kay'`. Without an exports map a component is imported by its path in the package.
- Settings the app may replace, such as theme classes or an icon resolver, live in one module named in package.json, `"kay": { "settings": "./src/settings.ts" }`, which default-exports the settings and which the library's components import.
- A library words its own texts in message catalogs, `<locale>.ts` each in one directory named in package.json, `"kay": { "messages": "./src/messages" }`: every app that installs it reads them under its own `src/messages`, key by key, with no line in `kay.config.ts` and no extension, a regional locale such as `fr-CA` reading its language's catalog when the library has none for the region. A library whose components call `t` with keys of its own must declare its catalog: once an app has any catalog, `kay check` types `t` from those and refuses keys that none holds. An extension's `messages` still serves a library that lists one.
- Define the defaults in a module of their own, `./src/defaults.ts`, re-exported by the settings module, `export { default } from './defaults'`, and export the settings type and the defaults from there for apps to extend, named for the library (`UiSettings` and `uiDefaults`) so they never clash with another library's: the app's module takes the place of the settings module, so anything read through it is the app's.
- A library logs with `logFrom('my-library')` from `kay` rather than `console`, so its lines follow the app's `log` setting, text, JSON or the app's function, headed by the request being answered (see [Request logs](production.md#request-logs)).
- A library imports an optional peer with `import()` inside a `try` block, or followed by `.catch`: Bun builds an app without the peer then, and fails on a bare `import()` of a package it cannot find.

### Using a component library

- Install it and import its components; `kay check`, the editor, auto-import and go-to-definition included, types them through `.kay/types/kay-packages.d.ts`, and needs no change to `tsconfig.json`.
- Only the components the app's imports reach ship: an island of the library the app never imports adds nothing to its bundles, unless a module re-exporting every component, such as a barrel `index.ts`, is imported.
- The classes in their templates and in the library scripts they import, default theme classes included, reach `.kay/classes.txt` with the app's own, so Tailwind builds them with no `@source` line.
- The app's stylesheets leave out each rule of a library's stylesheets whose selector needs a class nothing names, in `kay dev` and `kay build`, with Tailwind or without: kayjs-ui's theme ships only the components the app renders. A class counts as named when a file of the app's folder (templates, scripts, Markdown, HTML, stylesheets, JSON, YAML, comments included) or a library file it reaches writes it whole. A class put together at runtime (`` `kui-btn-${tone}` ``) or written only in content kept outside the project (a CMS body in the database) or in files outside the app's folder (a Tailwind `@source` elsewhere, a workspace package that is not a kay library) is not seen: write it whole in any file of the app, for instance in a comment in `app.css`, to keep its rules. Only the stylesheets the library's exports map reaches, and those they pull in with a relative `@import`, are pruned by.
- `kay check` reports a type error inside a library component the app uses once, at the component's own line; one the app never imports reports nothing.
- Errors inside the library's own `.ts` modules are the library's, as `skipLibCheck` leaves a declaration file's, so an optional peer the app has not installed reports nothing there, while the app's own calls into those modules are checked.
- `settings` in `kay.config.ts` replaces a library's settings module with the app's, by the library's name, on the server and in the browser: `settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`, a module default-exporting the library's settings type, `UiSettings` for kayjs-ui.
- The app's settings module may spread the library's defaults to change a few: `export default { ...defaults, tone: 'text-red-500' }`. `kay check` checks it against the defaults it replaces.
- One project renders with one set of settings: `bun test`, the server and `kay build` all read them from `kay.config.ts`.
- kay's own libraries, `@kaynooo/kayjs-auth`, `@kaynooo/kayjs-ui`, `@kaynooo/kayjs-mail`, `@kaynooo/kayjs-cms` and `@kaynooo/kayjs-ai`, are released with kay at its version, each peering on kay's minor and on the libraries of that same version: install the ones matching the app's kay, and move them together.
- An app on a `^0.x` range of one of kay's libraries moves it to kay's version by hand, as a caret on 0.x never reaches it.
- A library linked rather than installed, `"@kaynooo/kayjs-ui": "link:../kayjs-ui"`, works the same, and so does one installed in a `node_modules` above the project, as a workspace hoists it: the app's own `package.json` names it either way.

### Extensions

A library hands the app one value to list in `extensions` in `kay.config.ts`, typed `KayExtension` from `kay/server`, and the app needs no other line:

```ts
// The library's index.ts
import type { KayExtension } from 'kay/server'

export function auth({ prefix = '/auth' } = {}): KayExtension {
  return {
    name: '@kaynooo/kayjs-auth',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix },
    messages: `${import.meta.dir}/messages`,
    config: { head: [{ tag: 'meta', props: { name: 'referrer', content: 'same-origin' } }] },
  }
}
```

- `routes` lays a directory of the library's `.kay` pages, layouts, guards and special pages over the app's `src/routes` at `prefix`, the root by default: `routes/login.kay` serves `/auth/login`, its server fence, load and actions included, as if it were `src/routes/auth/login.kay`.
- A file of the app at the same path replaces the library's: `src/routes/auth/login.kay` serves `/auth/login` in its place, and the library's other pages stay.
- Layouts, guards, `_404.kay` and `_error.kay` resolve per URL directory across both trees, the app's file winning at a level both have one: the app's root layout wraps a library page, and a library `_layout.kay` wraps its pages, an app page replacing one of them included, unless the app has its own `_layout.kay` in `src/routes/auth`. A library layout whose `page` sets `layouts: false` starts the chain afresh, as an app's does: none of the app's layouts above wraps its pages, so a library with screens of its own (kayjs-cms's admin) draws its own chrome, and it imports the stylesheet those pages need, as the app's root layout is not there to. The app's `seo`, `fonts`, security headers and `kay.config.ts` head still apply, its layouts' own head tags and imported CSS do not.
- Its islands and stylesheets are bundled with the app's, and `kay build --compile` and `--static` carry its pages; a static export refuses a library page taking an action, as it refuses the app's, unless the app replaces it.
- `kay check` lets links point at its pages; type errors inside an installed library's files are the library's own check's.
- An extension listed by a path beside the app or through a link, as a library's own example or fixture app lists it, is checked as the app's own, by `kay check` and in the editor: its pages, its CMS editor and the components they reach, their route params typed, with the app's catalogs, `ctx.locals` and matchers in scope; under the options of the `tsconfig.json` in the extension's package when they differ from the app's, else under the app's; its `.ts` modules stay the library's own check's, and the dependencies its package installs itself resolve from its pages.
- A path an extension's routes name, a link, a redirect or a `localPath` fallback, is checked only when it goes under its own prefix, `/fr/auth/x` as `/auth/x`: `/` or any other page of the app, which no extension can know, is taken as written, and an extension mounted at the root checks none.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `layout` names one `.kay` layout, alone in its directory, that wraps every page outside the app's layouts: it renders its `slot` and then what the library mounts on every page, as kayjs-ui's `ui()` mounts a Toaster and a TooltipHost. Its imported stylesheet comes first on the page, so the app's own CSS overrides it. A page or layout setting `layouts: false` starts afresh without it, and it serves no page of its own.
- `api` lays a directory of API modules over the app's `src/api` at `prefix` the same way: `api/session.ts` serves `/api/auth/session` unless the app has `src/api/auth/session.ts`, and the app's `_guard.ts` files run before the library's.
- The server, the executable, `testSite`, the OpenAPI document and an island importing one, typed in `kay check`, see an extension's API modules as the app's own. A static export refuses them as it refuses the app's.
- `config` lies under the app's `kay.config.ts`, read by every command as if the app wrote it: objects merge key by key, arrays join with the extension's items first, and any other value the app sets wins, as does a later extension's over an earlier one's.
- A library needing Bun plugins for its files lists them in `config.plugins`, loading a native addon such as Tailwind's inside the plugin's `setup` rather than at import, since `kay build --compile` carries the library's module in the executable.
- Tags every page carries go in `config.head`, a CSP source in `config.security.csp`.
- `needsServer: true` marks an extension that does nothing without a running server, as a tracker posting to its own route: `kay build --static` warns of it.
- `staticFiles: { '/analytics.js': text }` names files a static export writes into the site, for what the extension's server would otherwise serve as a constant, as a script every page loads: `kay build --static` runs no server plugin.
- `server` hands kay an Elysia plugin that `pages()` uses before the pages, actions and API modules, so the app's `src/server.ts` needs no `.use(...)` of its own and none at all works.
- What the `server` plugin decorates, or derives `as: 'scoped'` or `'global'`, reaches their `ctx.locals`, and `kay check` types those locals and lets links point at its routes with no `Register` declaration of the app's, adding to the locals the app registers. A derive with no `as` reaches only the plugin's own routes.
- Given as a function, `server: async () => (await import('./server')).plugin`, it runs only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on the app's database or its server environment, or one whose module imports `.kay` files, as one imported while `kay.config.ts` loads comes before kay compiles any, and resolves to its path.
- `serverModule: { path: './src/auth', export: 'auth' }` names the module exporting the plugin instead, `default` when `export` is left out, a path relative to the project root: kay imports it as it does a function `server`, and `kay build --compile` bakes it into the executable, which a path a library builds at run time cannot. The export is the plugin, a function building it, called with no argument, or an object carrying the plugin as `plugin`, as a `createAuth` result does. `kay check` types the locals and links off the module itself, so a library taking the app's module needs no type of its own; `prepare: (exported) => ...` runs with the export before the plugin is taken from it, for a library to hand it what the extension was given (kayjs-auth's `prefix` and `home`), and a throw stops the server.
- A library that takes the app's module is named for the library and takes the path as `module`, `auth({ module: './src/auth' })` and `mail({ module: './src/mail' })`, built on `serverModule`. A plugin the library builds itself is typed `KayExtension<typeof plugin>` so its locals reach the app; typed a bare `KayExtension`, its plugin adds no locals and no routes to the check, and the app's own stay typed. A static export leaves it out.
- `kay dev` watches the app's files, not `node_modules`: after editing a linked library's pages, restart it.
- `messages` names a directory of catalogs, `<locale>.ts` each, laid under the app's `src/messages` key by key, with or without `i18n`: see [Locales](locales.md).
- `env` is a `defineEnv`-shaped schema of the variables the library reads, which `kay env` lists with the app's own, so a deploy script knows them with nothing wired in the app; it is not enforced at boot, and a field with `requiredInProduction: true` marks what production needs.
- `check` returns the problems with how the app configured the extension, `{ message, file?, severity?, help? }[]` (a warning at `kay.config.ts` by default), for what its server would otherwise only log or refuse once it listens: `kay check` and the editor call it with the content config read and its collections registered, never `server`, and a throw shows as an error. Name the collection and field path in each message; the boot keeps its own log or refusal.
- `transformPage` rewrites each prerendered page before it is written: see [Page hooks](prerendering.md#page-hooks).
- `editor` names a `.kay` island, `${import.meta.dir}/editor.kay`, that every page renders last in edit mode but the pages its own `routes` serve, its stylesheets linked after the page's, and carried by `kay build --compile`: see [A CMS editing on the page](content-cms.md#preview-mode).
- `commands` adds commands to `kay`, by a name of one word or more, `{ 'i18n translate': `${import.meta.dir}/translate.ts` }`: each module, absolute or relative to the project root, default-exports a `KayCommand` from `kay/library`, `{ usage, options, positionals, run(parsed, refuse, { root, config }) }`, `usage` its line after `kay ` and `options` as `node:util`'s `parseArgs` takes them; `refuse(reason)` prints the reason and the usage and answers 1, and `run` answers the exit code.
  - It runs in the project of the current directory, loaded only when run and when `kay --help` lists it under the library's name; `kay i18n` lists those under `i18n`.
  - A name kay has (`check`, `i18n missing`), one under a kay command that takes arguments (`check foo`), or one two extensions give stops the command, naming both.
  - `missingTranslations(root, config)` and `writeDraftMessages(root, config, locale, messages)` from `kay/library` give such a command what each locale lacks and write messages as drafts (see [Locales](locales.md#messages)).
- `devTool: { module }` names a browser module, `${import.meta.dir}/devTool.ts`, that adds a tab to the dev tool every dev page carries, with no declaration in the app: see [A tab for a library](#a-tab-for-a-library).

#### A tab for a library

The module is one file, absolute or relative to the project root, whose default export is called with the `DevTool` (`import type { DevTool } from 'kay/dev-tool'`) once the tool has started:

```ts
import type { DevTool } from 'kay/dev-tool'

export default function shopTab(tool: DevTool): void {
  const tab = tool.tab({ id: 'shop', label: 'Shop', shown: () => void show() })
  const show = async () => {
    const response = await fetch('/_kay/shop', { cache: 'no-store' })

    tab.panel.replaceChildren(tool.make('div', 'mono', response.ok ? JSON.stringify(await response.json()) : 'unavailable'))
  }
}
```

- `tool.tab({ id, label, icon?, summary?, announce?, shown?, hidden? })` adds a tab and gives its `panel`, to fill, and `count(n, 'error' | 'warn'?, note?)`, the number beside its name and on the bar, toned red or amber, `note` being what the bar says instead of `summary`'s, shown even at zero; `icon` names one of the tool's icons (`tool.icon(name)` makes one, `mail`, `user-round`, `pencil` and `puzzle`, the default, among them); `shown` and `hidden` run as it opens and closes, so a tab fetches its data when shown. `tool.make(tag, className?, text?)` makes an element, `tool.button(text, label, icon?)` a button on the bar, `tool.outline(elements, text)` and `tool.hideOutline()` outline elements of the page, `tool.open('file:line:column')` opens an editor.
- `make` takes the tool's own classes: `facts` (a `dl`), `row`, `chips` and `chip`, `pill` (with `error`, `warn`, `ok` or `accent`), `mono`, `note`, `empty`, `link`, `error`, `good`, `warn`, `tool` (a button), `actions`.
- It runs on dev pages only: `kay build` and a production server serve and write none of it. Two extensions naming one file load it once, in the order the extensions come, and a module that fails to load, throws or exports no function is logged as a problem naming its extension, the tool and the other tabs staying.
- Nothing bundles its imports, so a module imports types only. Its data and actions come from a route of the library's own, mounted under `kay dev` alone (`underKayDev()` from `kay/library`), under the `/_kay/` prefix; a module reads `<meta name="kay-base">` for the base. A route that answers 404, as outside `kay dev`, shows an empty tab saying so.
- kayjs-auth, kayjs-mail, kayjs-cms and kayjs-ai bring one each (see their pages), and kay adds the i18n tab itself.

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
- Routes a library mounts for itself are `/_kay/<library>`, never under the app's `/api`; kayjs-cms's `/api/cms/*` and kayjs-auth's `auth_*` tables are the drift left (#1782).
- CSS classes and ids are `k<library>-` (`kui-`, `kcms-`, `kai-`, `kauth-`, `kmail-`), kay's own `kay-`; a data attribute that names an element or marker is `data-k<library>-`, kay's `data-kay-`. A bare `data-tone` or `data-size` is the state of the component's own element (#1691).
- Cookies are `kay_<name>` and tables `kay_<plural name>`; the default session cookie is `kay_session` with the old name not read, and a library cookie renamed is still read under its old name for three minors (kayjs-cms's `kay_editor_session`).
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
