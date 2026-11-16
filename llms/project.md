# Project setup and scaffolding

## Common tasks

### Start a project

`kay new` scaffolds a project that already checks, builds and runs, from a preset (`blank`, `server`, `site` or `app`) plus the features added or dropped:

```sh
bunx -p @kayjs/kay kay new my-app --template app --without ws
```

### Set the project's settings

Settings live in a `kay.config.ts` at the root that `export default`s its config:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  dirs: { routes: 'src/routes' },
  lang: 'en',
  minify: true,
  client: { prefetch: 'moderate' },
  plugins: [],
})
```

### Serve the app's own routes next to the pages

Exporting `app` from the server entry lets links and redirects point at its GET routes and types `ctx.locals`:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia()
  .get('/feed.xml', () => '<feed/>')
  .use(await pages())
```

### Move an Astro project over

`kay migrate astro` translates the `.astro` files into `.kay` ones, writing into `--outdir` and never over a file that exists:

```sh
kay migrate astro ../my-astro-site --outdir ../my-kay-site
```

## Reference

### Project setup

- kay is published as `@kayjs/kay` to npm, and as a mirror to the Forgejo registry at `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, its libraries as `@kayjs/ui`, `@kayjs/auth`, `@kayjs/mail`, `@kayjs/cms` and `@kayjs/ai` (`@kaynooo/kayjs*` up to 1.103, which `kay upgrade` moves an app off), and installed under the name its imports use: `"kay": "npm:@kayjs/kay@~<version>"` in `package.json`, a tilde since a minor release may break what the one before it took, each break listed in [Upgrading](upgrading.md) and every one `kay check` can recognise a `deprecated` lint with a fix, which `kay upgrade` applies as it moves the app, and a major is a rewrite. Every package a project installs, pg-orm and eslint included, is on npm, so a project carries no `.npmrc` and Bun needs no registry setup.
- `bunx -p @kayjs/kay kay new my-app` writes a project that, after `cd my-app && bun install`, checks, builds and runs (`bun run dev`), both of those included: this setup, a layout, a page, a `_404.kay` and islands, or only what is picked of them (see [Commands](commands.md#commands) for the presets and features).

- kay runs on Bun 1.4.4 or later, as its `engines` says: the CLI and `pages()` refuse an older one, naming its version, its path and the fix, `bun update bun` when it is the project's npm `bun` package, which a plugin's peer dependency installs and package scripts run ahead of the system Bun.

- A folder of the project holding its own `package.json` or `kay.config.ts`, such as a workspace package or a second kay app, is a project of its own: `kay check` and `kay build` leave its files out of the app's, and the app reaches a package there through `node_modules`, as it would one installed.

- By hand, the server entry is:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia()
  .get('/feed.xml', feed)
  .use(await pages())
```

- The entry never calls `listen`: it is listened on `PORT` and `HOST` by `kay dev`, `kay start` and the executable, and one calling `listen` itself keeps its own call ([Build and start](build-and-start.md)).
- Plugins (sessions, jobs, a derive) go in `src/plugins/<name>.ts` instead, each default-exporting the plugin, so a project with only those needs no server entry ([Mount a server plugin](server.md#mount-a-server-plugin)).
- Exporting `app` lets links and redirects point at the app's own GET routes, such as `/feed.xml`, which `kay check` otherwise reports as served by no page, and types `ctx.locals` (see [Locals](server.md#locals)).
- An entry other than `src/server.ts` is named once, as `entry: 'src/main.ts'` in `kay.config.ts`, which `kay dev`, `start`, `render`, `check`, `build` and `build --compile` all read; `--entry` on a command wins over it, `kay build --entry` also pointing its check step at that entry.
- An entry `kay check` does not read registers it instead: `declare module 'kay' { interface Register { app: typeof app } }`.

- A key kay does not know in `kay.config.ts`, at its top or in any option bag (`security`, `i18n`, `assets`, `markdown`, `ops`, `cors`, `client` and the rest), stops every command with the nearest known name (`` `trailingslash`, did you mean `trailingSlash`? ``), and `defineConfig` types it as an error, since a mistyped key would otherwise leave kay's default in place with nothing said.
- A value that is not the kind its key takes (`trailingSlash: 'sometimes'`, `compress: 7`, `lang: 5`, a `default` locale outside the `locales`) stops them the same way, once, as the config loads: `` `trailingSlash` is "sometimes", expected one of "never", "always" or "ignore" ``, the path through bags and lists, with the nearest allowed value for a mistyped text. The options of `pages()` and `testSite()` are checked as they merge, and an extension's `config` as it loads.
- `auth()`, `cms()`, `mail()` and `ai()` refuse an option they do not take with the nearest one, as `kay.config.ts` does; a library adds the same to its own factory with `checkOptionKeys` from `kay/library`, over a `Record<keyof ItsOptions, true>`.
- Project settings live in an optional `kay.config.ts` at the root, read by `pages()` and every command; the `config` passed to `pages({ config })` or `testSite({ config })` wins over it key by key, an `undefined` key leaving the file's value (the config's keys written beside `root` work until 1.108, `deprecated-pages-options` rewrites them), and in an executable `kay build --compile` wrote, the root, routes and public directory it was built with win over both.
- It must `export default` its config, or the command fails with a message saying so.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  dirs: { routes: 'src/routes' },
  lang: 'en',
  minify: true,
  client: { prefetch: 'moderate' },
  plugins: [],
})
```

- A directory inside the project holding a `kay.config.ts` of its own, such as an example app or a documentation site, is another project: its components are never the outer one's islands, and it checks and builds from its own root.

- A feature key is `false` for off, `true` for its defaults or an object of options: `robots`, `sitemap`, `assets.favicon`, `security`, `ops.health`, `preview`, `client.offline`, `ops.metrics`, `openapi`, `mcp`, `proxy`, `assets.images.formats.avif` and the rate limits. `defineConfig` refuses a key it does not know in any option bag, as a type error.
- A list that may come from a CMS or a database is the list, or a function returning it (or a promise of it): `cors.origins`, `security.hosts`, `assets.images.remote.hosts`, `proxy.trusted`, `redirects`, `robots.disallow`, `robots.allow` and `i18n.paths`. Kay calls it once as the config loads, `kay dev` again after a change to the file.
- Keys are grouped by concern: `client` (what the browser is given: `links`, `offline`, `search`, ...), `assets` (`images`, `fonts`, `favicon`, `manifest`, `publicCache`), `ops` (`observe`, `health`, `metrics`, `jobs`), `endpoints` (where the app's API and each feature are served) and `i18n: { locales, default, mode }`, where `mode` is `'prefix'` (the default locale unprefixed), `'always'` or `{ domains }`. The old top-level keys work until 1.108 (`deprecated-client-keys`, `deprecated-config-groups`, `deprecated-i18n-keys` rewrite them).
- `endpoints` holds every route the config moves, in one place: `{ api: '/api', openapi: '/api/openapi.json', mcp: '/_kay/mcp', health: '/_kay/health', metrics: '/_kay/metrics', jobs: '/_kay/jobs' }`, each an absolute path of plain segments, no trailing slash, and none of them under `/_kay` when you set it. Every default is under `/_kay` but the app's API (and its OpenAPI document and reference page, which follow it). The reference page is `openapi: { reference: true }` or `{ reference: { path } }`. `serve.apiPrefix` and the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs`, and `openapi.referencePath`, work until 1.108 (`deprecated-route-keys` rewrites them). An app that did not move `mcp` or `metrics` keeps `/mcp` (a 308 to the new path) and `/metrics` (answered as well) until 1.108.
- `assets.images` is `{ remote: { hosts, maxSize, timeout }, formats: { quality, webp, avif }, limits: { variants, queue }, rateLimit, ttl, widths, ... }`; `remote: [...]` is hosts alone.
- A duration key is `ttl` for how long data lives, `timeout` for how long to wait and `maxAge` only for the HTTP or cookie attribute of that name.
- `proxy: false` is none, `proxy: true` is one proxy in front, `proxy: { hops: 2 }` two, `{ header }` a header the proxy sets, `{ key: { header: 'x-upstream-key' }, open }` refuses requests without the shared key ([Production](proxy-and-security.md#behind-a-proxy)).
- `extensions` lists what libraries add to the app, one value each, such as `extensions: [auth()]`: pages laid over `src/routes` and API modules over `src/api` under a prefix, message catalogs under `src/messages`, an app file at the same path or an app key winning, config laid under the app's, such as Bun plugins or head tags (see [Extensions](component-libraries.md#extensions)), and a hook rewriting each prerendered page (see [Page hooks](prerendering.md#page-hooks)).

- `minify` is on for `kay build` unless set to `false`, and off for `kay dev` and a server bundling at boot unless set to `true`.
- `lang`, the `<html lang>` of every page when `i18n` is not set, defaults to `en`.
- `timeZone: 'Europe/Paris'` is the zone `formatDate` and message dates write in, on the server and in islands alike, instead of the server's and the visitor's ([Locales](locales.md)).
- `typography: false` leaves a French page's spaces before `: ; ! ?` and inside `« »` as typed instead of making them non-breaking ([Locales](locales.md#french-typography)).
- `client.links: { outside: 'same-tab' }` keeps a link to another origin in the same tab, where it opens in a new one by default ([Navigation](navigation.md#navigation)); `client.links: { schemes: ['webcal'] }` lets a bound URL keep a scheme beyond the web's, mail, phone and sms ([Security](proxy-and-security.md)).

- A page without kay's script carries speculation rules, and one shipping it a `kay-prefetch` meta naming the setting alone, as the swap prefetches its links itself (see [Navigation](navigation.md#navigation)): Chromium, or the swap, prefetches the page a link points at once it is hovered (`prefetch: 'moderate'`), on press with `'conservative'`, as soon as it can with `'eager'` (every link on a page without the script, the links scrolled into view, three at a time, on one with it), never with `false`; `data-prefetch="eager|moderate|conservative"` on a link or a container sets its own level where the script runs, `data-prefetch="false"` opts out everywhere; a page with no `data-prefetch` in it carries the shorter rules without the selector that follows the nearest one.
- Links under `/_kay/` or `/api/`, with `download` or with `rel="nofollow"` are never prefetched; any other link that changes something on GET, such as a logout, takes `data-no-prefetch`.
- A stylesheet holding `@view-transition { navigation: auto; }` animates from page to page where the browser supports it, swaps included; `kay new` writes one inside `@media (prefers-reduced-motion: no-preference)`.

- `pages()` also takes `root`, `dev` (default: `NODE_ENV` is `development`) and `prebuilt` (default: `NODE_ENV` is `production`), which serves what `kay build` wrote instead of bundling at boot.
- A `.ts` file imports a component as `import Card from './card.kay'`, typed through the generated `.kay/types` tree, which `kay dev` writes again on every restart, from `kay.config.ts` as it is once it changed, the modules it imports as they were.
- `.kay/` also holds the client build and the compile cache.
- List it in `.gitignore`.
- `tsconfig.json` extends kay's, which merges that tree with the sources and is as strict as kay itself:

```json
{ "extends": "kay/tsconfig.json" }
```

- Kay's tsconfig is as strict as kay itself: `noUncheckedIndexedAccess` types `cells[index]` as `Cell | undefined`, and `exactOptionalPropertyTypes` makes an optional field passed `undefined` say `?: T | undefined`, so plain TypeScript written without them reports errors in files no `.kay` touches. Add `"noUncheckedIndexedAccess": false` (or `"exactOptionalPropertyTypes": false`) to the app's `compilerOptions` to keep such code as it is, or write the `!` or the `?.` where the index is known to exist.
- It includes `src`, `tests`, `scripts`, the `*.config.ts` files beside it, such as `kay.config.ts`, `eslint.config.ts` and `pg-orm.config.ts`, and `.kay/types`, relative to the project's tsconfig.
- A project adds its own `compilerOptions` beside `extends`, and an `include` of its own replaces kay's, so it lists `.kay/types` again; one setting up its tsconfig by hand needs `"jsx": "preserve"`, `"jsxImportSource": "kay"`, `"module": "Preserve"`, `"moduleResolution": "bundler"` and `"rootDirs": [".", ".kay/types"]`.

- `kay/html`, `kay/dom`, `kay/dom-loop`, `kay/dom-await`, `kay/dom-try`, `kay/dom-spread`, `kay/dom-image`, `kay/pending`, `kay/i18n-links`, `kay/island`, `kay/await`, `kay/client`, `kay/arrival`, `kay/internal`, `kay/internal/title` and `kay/internal/server` are what compiled `.kay` files and kay's generated entries import, and `kay/jsx-runtime` is where TypeScript finds the JSX types of `jsxImportSource: "kay"`: the compiler's output contract rather than API, free to change in any release, never imported by an app. The root `kay` export also holds the compile-time types behind the generated shadow types, none of them for an app to name: `BindableMark`, `IslandBrand`, `HandedPart`, `HandsPart`, `HandedSignal`, `UnresolvedParameter`, `WidenedProps`, `CheckedHref`, `CheckedHtml`, `CheckedComputedHtml`, `BoundProp`, `BoundValue`, `PlainIslandProp`, `FunctionProp`, `Inferred`, `TemplateHelpers`, `TemplateValues` and `Truthy`, free to change in any release too.
- A few entries also hold plumbing no page tells an app to call, free to change in any release: the paths, providers and tracker tags of `kay/analytics` (`ANALYTICS_PATH`, `ANALYTICS_SCRIPT_PATH`, `ANALYTICS_PROVIDERS`, `CUSTOM_COLLECT_PATH`, `CUSTOM_SCRIPT_PATH`, `NOTICE_SCRIPT_PATH`, `INTEGRITY`, `TRACKER_TAGS`, `isGated`, `LazyGuard`), the collection marker, publish times and cache key of `kay/content`, and the preview session reader of `kay/server`.
- A name has one home: an entry beside a package's root exists for browser safety (`@kayjs/auth/rules`, `@kayjs/cms/form`, which an island imports without the server) and the root does not repeat its names. The copies in `kay/mount` and `kay/server` that 1.105 moved (`mount`, `s`, `RateLimit`, `sqliteCache`) stay as deprecated shims until 1.108.
- `kay/library` is what kay's own libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms, kayjs-ai) share with kay for their server code, such as the sanitizer's lists, sealing, locale matching, escaping and the user a library names for a request (`nameUser(request, () => id)`, read back by `userOf(request)`: kayjs-auth names the signed-in user and kayjs-ai counts them) and `configError(option, value, takes)`, the `config-invalid` `KayError` a library throws for a setting it refuses at boot, so neither keeps a copy: not API either, free to change with any minor, never imported by an app. The libraries are released in lockstep with kay, each one's peer range on kay's minor, so the same holds for what a library imports from it.

### Reserved paths

- Naming rule: a file kay reads for one thing is singular (`server.ts`, `auth.ts`, `mail.ts`, `ui.ts`, `context.ts`, `env.ts`, `theme.ts`); a folder with one file per page, plugin, template, matcher or catalog is plural (`routes/`, `plugins/`, `mails/`, `messages/`, `params/`); a mass noun or acronym stays as is (`api/`, `content/`, `db/`); a file inside a plural folder is named after what it holds (`plugins/metrics.ts`). A route is `/_kay/<noun>` for an endpoint and `/_kay/<nouns>/` for files; the image resizer shares its variants' prefix, `/_kay/images` and `/_kay/images/<file>`.
- At the root: `kay.config.ts`, `public/` (served as is), `data/` (default SQLite and file stores, ignored by git and docker).
- Under `src/`: `routes/` (pages, layouts, endpoints, `_guard.ts`), `api/`, `plugins/` (server plugins), `jobs/` (queues, workflows and schedules, each export mounted), `messages/<locale>.ts`, `params/<name>.ts`, `content/` with `content.config.ts`, `mails/<name>.kay` with `<name>.preview.ts` beside it and `mail.ts` for the mailer, `db/index.ts` and `tables.ts`, `server.ts`, `auth.ts`, `ui.ts`, `context.ts`, `env.ts`, `theme.ts`, `app.css`, `logo.svg` (the card logo, where `card.logo` names it).
- Under `/_kay/`: `assets/` (browser build, imported files), `images` and `images/` (resizer, variants), `card`, `files/`, `action/`, `live`, `health`, `mcp`, `metrics`, `jobs` (with `ops: { jobs: { guards } }`), `error`, `csp`, `vitals`, `analytics`, `push`, `search.json` and `search/`, `preview`, `draft`, `env.js`.
