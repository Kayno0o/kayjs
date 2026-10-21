---
title: Component libraries and extensions
order: 9.4
description: Ship .kay components in a package, and add pages, API routes, config and a dev tool tab to an app with one extension.
---

## Shipping components

A package can ship `.kay` files. The app that installs it compiles them as its own, on the server and in islands.

```json
{
  "name": "my-ui",
  "exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" },
  "peerDependencies": { "kay": "~1.51.0" },
  "kay": { "settings": "./src/settings.ts" }
}
```

Ship the sources, not a build. List `kay` under `peerDependencies` and import from `kay`, so the app's one copy of kay serves the library too.

The exports map gives each component a specifier: `import Button from 'my-ui/button.kay'`. Without it, a component is imported by its path in the package.

## Texts in the app's languages

Put the texts your components show in one folder of catalogs, one file per language, and name it in `package.json`:

```json
{
  "kay": { "messages": "./src/messages" }
}
```

Every app that installs your library reads those texts with no line in `kay.config.ts`. The app's own `src/messages` wins key by key. A page in `fr-CA` reads your `fr.ts` when you have no `fr-CA.ts`. Declare it as soon as a component calls `t` with a key of your own: once any library ships a catalog, `kay check` types `t` from the catalogs and refuses a key none of them holds.

A language you ship no catalog for shows your texts in the app's default language, and `kay check` does not ask the app to translate them.

## Settings the app can replace

Put what an app may change, such as theme classes, in one module. Name it under `"kay": { "settings" }` in `package.json`. It default-exports the settings, and your components import it.

An app replaces it by the library's name in `kay.config.ts`:

```ts
export default defineConfig({
  settings: { 'my-ui': './src/my-ui-settings.ts' },
})
```

## Logging

Log with `logFrom` instead of `console`. Your lines then follow the app's `log` setting.

```ts
import { logFrom } from 'kay'

const log = logFrom('my-ui')
```

## Extensions

A library that serves more than components hands the app one value to list in `extensions`. The value is typed `KayExtension`, and the app needs no other line.

```ts
import type { KayExtension } from 'kay/server'

export function shopPages({ prefix = '/shop' } = {}): KayExtension {
  return {
    name: 'my-shop',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix },
    messages: `${import.meta.dir}/messages`,
  }
}
```

The app lists it:

```ts
export default defineConfig({ extensions: [shopPages()] })
```

An extension may set these fields. Only `name` is required.

- `routes`: a folder of `.kay` pages, layouts and guards, served at `prefix`. A file of the app at the same path replaces the library's.
- `api`: a folder of API modules, served at `/api/<prefix>`, replaceable the same way.
- `config`: config laid under the app's own. Objects merge, arrays join with yours first, and a value the app sets wins.
- `server`: an Elysia plugin used before the pages and API modules. Give a function to build it only when the server starts.
- `serverModule`: the same plugin named by a file, `{ path: './src/shop', export: 'shop' }`. Unlike a path built at run time, `kay build --compile` carries it. The export may be the plugin, a function building it, or an object carrying it as `plugin`, and `kay check` types the locals off the file itself. This is how a library takes the app's module: kayjs-auth and kayjs-mail are `auth({ module: './src/auth' })` and `mail({ module: './src/mail' })`.
- `messages`: a folder of message catalogs, one `<locale>.ts` each. A key the app translates is the app's.
- `env`: the variables the library reads, as a `defineEnv` schema. `kay env` lists them with the app's.
- `transformPage`: rewrites each prerendered page before it is written.
- `needsServer`: set it when the extension does nothing without a running server, as a tracker posting to a route of its own. `kay build --static` warns about it.
- `staticFiles`: files a static export writes into the site, by path, for what the extension's server would otherwise serve, such as a script every page loads.
- `layout`: one `.kay` layout, alone in its directory, wrapping every page outside the app's layouts. It renders its `slot` and then what the library mounts on every page, such as a toaster; its stylesheet comes before the app's, and a page setting `layouts: false` starts afresh without it.
- `editor`: a `.kay` island rendered last on every page in edit mode.
- `check`: a function returning the problems with how the app configured the extension, as `{ message, file?, severity?, help? }`. `kay check` and the editor show them beside kay's own without starting the server, so a mistake the library would only log once the server listens is seen as you type. A warning at `kay.config.ts` unless it names a file.
- `devTool`: a browser module adding a tab to the dev tool.
- `commands`: commands added to `kay`, such as `kay i18n translate`. Each names a module whose default export is a `KayCommand` from `kay/library`. It runs in the project of the current directory and gets its root and config.

Type the result `KayExtension<typeof plugin>` when it has a `server` of its own, so the plugin's locals reach the app's types.

## A tab in the dev tool

Every page under `kay dev` carries a dev tool. An extension adds a tab with `devTool`:

```ts
return { name: 'my-shop', devTool: { module: `${import.meta.dir}/devTool.ts` } }
```

The module default-exports a function. It receives the tool, typed `DevTool` from `kay/dev-tool`.

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

`tool.tab` returns the tab with its `panel` to fill. `shown` runs when the tab opens, so fetch the data there. `tool.make(tag, className, text)` makes an element.

The module is one file and nothing bundles its imports, so import types only. Get data from a route of your own that exists under `kay dev` alone: wrap it with `underKayDev()` from `kay/library` and mount it under `/_kay/`.

Nothing of this reaches `kay build` or a production server.

## Naming conventions

kay and its libraries name the same idea the same way. A new option, export or file follows these rules. Some older code still uses another name, and each such name is being moved to the rule.

### Options

- `site` is the public address of the site, and it defaults to kay's own `site`. `name` is a display name.
- A duration is a string with its unit, such as `'30s'` or `'5m'`. Every option, store argument and test helper takes this form, never a bare number.
- `maxAge` is how long something stays valid. `timeout` is how long to wait. `expires` is a date.
- `maxSize` is a size limit. It takes bytes or a string such as `'2mb'`.
- `rateLimit` sets a rate limit with `max` and `window`. `key` says who is counted. A library with several limits nests them under `rateLimit`.
- A list by page uses `page` and `pageSize`. A window onto a list uses `limit` and `offset`.
- Look goes in the library's settings module. Behaviour goes in the call.

### Hooks and switches

- An `on*` hook takes one event object and returns nothing.
- A callback that returns data is named for what it returns, such as `profileFields`.
- `false` turns off something that is on by default. `true` turns on something that is off by default.

### Errors

- A wrong option at start-up throws `KayError('config-invalid')`, in a library too.
- An error class ends in `Error` and has a `code`. kay's own do too: `HydrationMismatchError` of `kay/dom` was `HydrationMismatch`, which stays as a deprecated alias for three minors.

### Prefixes

- A library mounts its own routes under `/_kay/<library>`, not under `/api`.
- CSS classes start with `k<library>-`, such as `kui-` or `kcms-`. Data attributes start with `data-k<library>-`.
- Cookies and tables start with `kay_`. Table names are plural.
- A name that two libraries would both export is prefixed with the library. A Postgres entry is spelled `pg`.

### Texts and docs

- A library looks text up with `wording`, ships a French catalog, and names its catalogs in `package.json` under `kay.messages`.
- Each topic file in `llms/` has `## Common tasks` first and `## Reference` after it. A library's `llms.txt` is a short index of links.

### Methods, props and the command line

- A library lists with `list<Things>`, reads one with `get<Thing>`, revokes a credential with `revoke<Thing>`, and deletes a record with `delete<Thing>`. A call that can be refused returns `{ ok }`.
- A kayjs-ui prop that picks a style is an enum: `variant`, `tone` or `size`. A pending state is `busy`. Open state is `open` with `onOpenChange`.
- A command that writes takes `--dry-run`. `kay fmt --check` keeps the form every formatter uses. A command that prints takes `--quiet` and `--format`.

<ReadMore href="/llms/component-libraries">Using a library, pruned stylesheets, extension checks, layouts, the dev tool's classes and every option.</ReadMore>
