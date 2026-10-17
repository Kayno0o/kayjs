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
- `serverModule`: the same plugin named by a file, `{ path: './src/shop', export: 'shop' }`. Unlike a path built at run time, `kay build --compile` carries it.
- `messages`: a folder of message catalogs, one `<locale>.ts` each. A key the app translates is the app's.
- `env`: the variables the library reads, as a `defineEnv` schema. `kay env` lists them with the app's.
- `transformPage`: rewrites each prerendered page before it is written.
- `editor`: a `.kay` island rendered last on every page in edit mode.
- `devTool`: a browser module adding a tab to the dev tool.

Type the result `KayExtension<typeof plugin>` when it has a `server`, so the plugin's locals reach the app's types.

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

<ReadMore href="/llms/component-libraries">Using a library, pruned stylesheets, extension checks, layouts, the dev tool's classes and every option.</ReadMore>
