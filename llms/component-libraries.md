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
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
```

## Reference

### Publishing a component library

A package can ship `.kay` components, which the app installing it compiles as its own: on the server, in islands, and in `kay build --compile` and `--static`.

- Ship the `.kay` sources, list `kay` under `peerDependencies`, and import from `kay`, so the app's one copy of kay, and its registered types, serve the library too.
- Give each component a specifier in the exports map, `"exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" }`, imported as `import Button from '@kaynooo/kayjs-ui/button.kay'`. Without an exports map a component is imported by its path in the package.
- Settings the app may replace, such as theme classes or an icon resolver, live in one module named in package.json, `"kay": { "settings": "./src/settings.ts" }`, which default-exports the settings and which the library's components import.
- Define the defaults in a module of their own, `./src/defaults.ts`, re-exported by the settings module, `export { default } from './defaults'`, and export the `Settings` type and the defaults from there for apps to extend: the app's module takes the place of the settings module, so anything read through it is the app's.
- A library logs with `logFrom('my-library')` from `kay` rather than `console`, so its lines follow the app's `log` setting, text, JSON or the app's function, headed by the request being answered (see [Request logs](production.md#request-logs)).
- A library imports an optional peer with `import()` inside a `try` block, or followed by `.catch`: Bun builds an app without the peer then, and fails on a bare `import()` of a package it cannot find.

### Using a component library

- Install it and import its components; `kay check`, the editor, auto-import and go-to-definition included, types them through `.kay/types/kay-packages.d.ts`, and needs no change to `tsconfig.json`.
- Only the components the app's imports reach ship: an island of the library the app never imports adds nothing to its bundles, unless a module re-exporting every component, such as a barrel `index.ts`, is imported.
- The classes in their templates and in the library scripts they import, default theme classes included, reach `.kay/classes.txt` with the app's own, so Tailwind builds them with no `@source` line.
- The app's stylesheets leave out each rule of a library's stylesheets whose selector needs a class nothing names, in `kay dev` and `kay build`, with Tailwind or without: kayjs-ui's theme ships only the components the app renders. A class counts as named when a file of the app's folder (templates, scripts, Markdown, HTML, stylesheets, JSON, YAML, comments included) or a library file it reaches writes it whole. A class put together at runtime (`` `kui-btn-${tone}` ``) or written only in content kept outside the project (a CMS body in the database) or in files outside the app's folder (a Tailwind `@source` elsewhere, a workspace package that is not a kay library) is not seen: write it whole in any file of the app, for instance in a comment in `app.css`, to keep its rules. Only the stylesheets the library's exports map reaches, and those they pull in with a relative `@import`, are pruned by.
- `kay check` reports a type error inside a library component the app uses once, at the component's own line; one the app never imports reports nothing.
- Errors inside the library's own `.ts` modules are the library's, as `skipLibCheck` leaves a declaration file's, so an optional peer the app has not installed reports nothing there, while the app's own calls into those modules are checked.
- `settings` in `kay.config.ts` replaces a library's settings module with the app's, by the library's name, on the server and in the browser: `settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`, a module default-exporting the library's `Settings`.
- The app's settings module may spread the library's defaults to change a few: `export default { ...defaults, tone: 'text-red-500' }`. `kay check` checks it against the defaults it replaces.
- One process renders with one set of settings: `kay test`, the server and `kay build` all read them from `kay.config.ts`.
- kay's own libraries, `@kaynooo/kayjs-auth`, `@kaynooo/kayjs-ui`, `@kaynooo/kayjs-mail`, `@kaynooo/kayjs-cms` and `@kaynooo/kayjs-ai`, are released with kay at its version, each peering on kay's minor and on the libraries of that same version: install the ones matching the app's kay, and move them together.
- An app on a `^0.x` range of one of kay's libraries moves it to kay's version by hand, as a caret on 0.x never reaches it.
- A library linked rather than installed, `"@kaynooo/kayjs-ui": "link:../kayjs-ui"`, works the same, and so does one installed in a `node_modules` above the project, as a workspace hoists it: the app's own `package.json` names it either way.

### Extensions

A library hands the app one value to list in `extensions` in `kay.config.ts`, typed `KayExtension` from `kay/server`, and the app needs no other line:

```ts
// The library's index.ts
import type { KayExtension } from 'kay/server'

export function authPages({ prefix = '/auth' } = {}): KayExtension {
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
- Layouts, guards, `_404.kay` and `_error.kay` resolve per URL directory across both trees, the app's file winning at a level both have one: the app's root layout wraps a library page, and a library `_layout.kay` wraps its pages, an app page replacing one of them included, unless the app has its own `_layout.kay` in `src/routes/auth`.
- Its islands and stylesheets are bundled with the app's, and `kay build --compile` and `--static` carry its pages; a static export refuses a library page taking an action, as it refuses the app's, unless the app replaces it.
- `kay check` lets links point at its pages; type errors inside an installed library's files are the library's own check's.
- An extension listed by a path beside the app or through a link, as a library's own example or fixture app lists it, is checked as the app's own, by `kay check` and in the editor: its pages, its CMS editor and the components they reach, their route params typed, with the app's catalogs, `ctx.locals` and matchers in scope; under the options of the `tsconfig.json` in the extension's package when they differ from the app's, else under the app's; its `.ts` modules stay the library's own check's, and the dependencies its package installs itself resolve from its pages.
- A path an extension's routes name, a link, a redirect or a `localPath` fallback, is checked only when it goes under its own prefix, `/fr/auth/x` as `/auth/x`: `/` or any other page of the app, which no extension can know, is taken as written, and an extension mounted at the root checks none.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `api` lays a directory of API modules over the app's `src/api` at `prefix` the same way: `api/session.ts` serves `/api/auth/session` unless the app has `src/api/auth/session.ts`, and the app's `_guard.ts` files run before the library's.
- The server, the executable, `testSite`, the OpenAPI document and an island importing one, typed in `kay check`, see an extension's API modules as the app's own. A static export refuses them as it refuses the app's.
- `config` lies under the app's `kay.config.ts`, read by every command as if the app wrote it: objects merge key by key, arrays join with the extension's items first, and any other value the app sets wins, as does a later extension's over an earlier one's.
- A library needing Bun plugins for its files lists them in `config.plugins`, loading a native addon such as Tailwind's inside the plugin's `setup` rather than at import, since `kay build --compile` carries the library's module in the executable.
- Tags every page carries go in `config.head`, a CSP source in `config.security.csp`.
- `server` hands kay an Elysia plugin that `pages()` uses before the pages, actions and API modules, so the app's `src/server.ts` needs no `.use(...)` of its own and none at all works.
- What the `server` plugin decorates, or derives `as: 'scoped'` or `'global'`, reaches their `ctx.locals`, and `kay check` types those locals and lets links point at its routes with no `Register` declaration of the app's, adding to the locals the app registers. A derive with no `as` reaches only the plugin's own routes.
- Given as a function, `server: async () => (await import('./server')).plugin`, it runs only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on the app's database or its server environment, or one whose module imports `.kay` files, as one imported while `kay.config.ts` loads comes before kay compiles any, and resolves to its path.
- `serverModule: { path: './src/auth', export: 'auth' }` names the module exporting the plugin instead, `default` when `export` is left out, a path relative to the project root: kay imports it as it does a function `server`, and `kay build --compile` bakes it into the executable, which a path a library builds at run time cannot. The export is the plugin or a function building it, called with no argument. A library helper that takes a path types its result `KayExtension<typeof plugin>` as well, as `mailExtension('./src/mail')` does.
- The library types it `KayExtension<typeof plugin>` so its locals reach the app; typed a bare `KayExtension`, its plugin adds no locals and no routes to the check, and the app's own stay typed. A static export leaves it out.
- `kay dev` watches the app's files, not `node_modules`: after editing a linked library's pages, restart it.
- `messages` names a directory of catalogs, `<locale>.ts` each, laid under the app's `src/messages` key by key, with or without `i18n`: see [Locales](locales.md).
- `env` is a `defineEnv`-shaped schema of the variables the library reads, which `kay env` lists with the app's own, so a deploy script knows them with nothing wired in the app; it is not enforced at boot, and a field with `requiredInProduction: true` marks what production needs.
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

- `tool.tab({ id, label, icon?, summary?, announce?, shown?, hidden? })` adds a tab and gives its `panel`, to fill, and `count(n, 'error' | 'warn'?)`, the number beside its name and on the bar, toned red or amber; `icon` names one of the tool's icons (`tool.icon(name)` makes one, `mail`, `user-round`, `pencil` and `puzzle`, the default, among them); `shown` and `hidden` run as it opens and closes, so a tab fetches its data when shown. `tool.make(tag, className?, text?)` makes an element, `tool.button(text, label, icon?)` a button on the bar, `tool.outline(elements, text)` and `tool.hideOutline()` outline elements of the page, `tool.open('file:line:column')` opens an editor.
- `make` takes the tool's own classes: `facts` (a `dl`), `row`, `chips` and `chip`, `pill` (with `error`, `warn`, `ok` or `accent`), `mono`, `note`, `empty`, `link`, `error`, `good`, `warn`, `tool` (a button), `actions`.
- It runs on dev pages only: `kay build` and a production server serve and write none of it. Two extensions naming one file load it once, in the order the extensions come, and a module that fails to load, throws or exports no function is logged as a problem naming its extension, the tool and the other tabs staying.
- Nothing bundles its imports, so a module imports types only. Its data and actions come from a route of the library's own, mounted under `kay dev` alone (`underKayDev()` from `kay/library`), under the `/_kay/` prefix; a module reads `<meta name="kay-base">` for the base. A route that answers 404, as outside `kay dev`, shows an empty tab saying so.
- kayjs-auth, kayjs-mail and kayjs-cms bring one each (see their pages), and kay adds the i18n tab itself.
