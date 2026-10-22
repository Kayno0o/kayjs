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
- An extension listed by a path beside the app or through a link, as a library's own example or fixture app lists it, is checked as the app's own, by `kay check` and in the editor: its pages, its CMS editor and the components they reach, their route params typed, with the app's catalogs, `ctx.locals` and matchers in scope, under the `tsconfig.json` options of the extension's package when they differ from the app's; its `.ts` modules stay the library's own check's, and the dependencies its package installs itself resolve from its pages.
- A path an extension's routes name, a link, a redirect or a `localPath` fallback, is checked only when it goes under its own prefix, `/fr/auth/x` as `/auth/x`: `/` or any other page of the app is taken as written, and an extension mounted at the root checks none.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `layout` names one `.kay` layout, alone in its directory, that wraps every page outside the app's layouts: it renders its `slot` and then what the library mounts on every page, as kayjs-ui's `ui()` mounts a Toaster and a TooltipHost. Its imported stylesheet comes first on the page, so the app's own CSS overrides it. A page or layout setting `layouts: false` starts afresh without it, and it serves no page of its own. `layout: { file, reaching: [...] }` wraps only the pages whose imports (the page, its layouts and every `.kay` file and app script they import, however deep) reach one of the `reaching` files, so a library reading per-request data on the first bytes pays only where its components are used. The files an `import.meta.glob` pattern matches are followed; a computed `import(x)` or a script in `node_modules` is not.
- `context` names a module default-exporting `defineContext(load)`: its request values are `ctx.<key>` in any template, loaded only for pages reaching one that reads `ctx` ([Request values](request-values.md)).
- `api` lays a directory of API modules over the app's `src/api` at `prefix` the same way: `api/session.ts` serves `/api/auth/session` unless the app has `src/api/auth/session.ts`, and the app's `_guard.ts` files run before the library's. A `prefix` starting with `/_kay/` is served there whatever `apiPath` is (kayjs-cms's `/_kay/cms`), and `former` names the prefix it had under `apiPath`, which keeps answering for the three minors the library says.
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
- `appFiles: { hooks: 'src/auth.ts' }` names optional files of the app, by the name the library reads them by: kay imports each one that exists, hands a `server` function `({ root, modules, extensions })` (`modules.hooks` being the module or undefined, `root` the folder the library keeps its files in, `extensions` the names of every extension the config lists, to tell which libraries the app registered, in an executable too), bakes them into the executable and reloads them under `kay dev`. A path outside the project root, a symlink leading out of it included, stops the server.
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
- `references: [path]` lists stylesheets the app's own may `@apply` and read `theme()` of with no `@reference` line, as if each began with one (kayjs-ui lists its `theme.css`): added after the Tailwind import of each stylesheet of the app (or of one using `@apply`, `@variant` or a theme function without it), and it writes no rule.
- `devTool: { module }` names a browser module, `${import.meta.dir}/devTool.ts`, that adds a tab to the dev tool every dev page carries, with no declaration in the app: see [A tab for a library](dev-tool.md#a-tab-for-a-library).

The conventions a library follows are in [Component libraries: conventions](component-library-conventions.md).
