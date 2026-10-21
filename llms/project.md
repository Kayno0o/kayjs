# Project setup and scaffolding

## Common tasks

### Start a project

`kay new` scaffolds a project that already checks, builds and runs, from a preset (`blank`, `server`, `site` or `app`) plus the features added or dropped:

```sh
bunx -p @kaynooo/kayjs kay new my-app --template app --without ws
```

### Set the project's settings

Settings live in a `kay.config.ts` at the root that `export default`s its config:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  routes: 'src/routes',
  lang: 'en',
  minify: true,
  prefetch: 'moderate',
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
  .listen(3000)
```

### Move an Astro project over

`kay migrate astro` translates the `.astro` files into `.kay` ones, writing into `--outdir` and never over a file that exists:

```sh
kay migrate astro ../my-astro-site --outdir ../my-kay-site
```

## Reference

### Project setup

- kay is published as `@kaynooo/kayjs` to the registry at `https://git.kaynooo.fr/api/packages/kaynooo/npm/` and installed under the name its imports use: `"kay": "npm:@kaynooo/kayjs@~<version>"` in `package.json`, a tilde since a minor release may break what the one before it took, each break listed in [Upgrading](upgrading.md) and every one `kay check` can recognise a `deprecated` lint with a fix, which `kay upgrade` applies as it moves the app, and a major is a rewrite, with `@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/` in the project's `.npmrc`.
- Before the first `kay new`, Bun is told once where the `@kaynooo` scope lives, in `~/.bunfig.toml`: `[install.scopes]` with `"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"`.
- `bunx -p @kaynooo/kayjs kay new my-app` writes a project that, after `cd my-app && bun install`, checks, builds and runs (`bun run dev`), both of those included: this setup, a layout, a page, a `_404.kay` and islands, or only what is picked of them (see [Commands](#commands) for the presets and features).

- kay runs on Bun 1.4.3 or later, as its `engines` says: the CLI and `pages()` refuse an older one, naming its version, its path and the fix, `bun update bun` when it is the project's npm `bun` package, which a plugin's peer dependency installs and package scripts run ahead of the system Bun.

- A folder of the project holding its own `package.json` or `kay.config.ts`, such as a workspace package or a second kay app, is a project of its own: `kay check` and `kay build` leave its files out of the app's, and the app reaches a package there through `node_modules`, as it would one installed.

- By hand, the server entry is:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia()
  .get('/feed.xml', feed)
  .use(await pages())
  .listen(3000)
```

- Exporting `app` lets links and redirects point at the app's own GET routes, such as `/feed.xml`, which `kay check` otherwise reports as served by no page, and types `ctx.locals` (see [Locals](server.md#locals)).
- An entry other than `src/server.ts` is named once, as `entry: 'src/main.ts'` in `kay.config.ts`, which `kay dev`, `start`, `render`, `check`, `build` and `build --compile` all read; `--entry` on a command wins over it, `kay build --entry` also pointing its check step at that entry.
- An entry `kay check` does not read registers it instead: `declare module 'kay' { interface Register { app: typeof app } }`.

- Project settings live in an optional `kay.config.ts` at the root, read by `pages()` and every command; options passed to `pages()` or `testSite()` win over it key by key, an `undefined` option leaving the file's value, and in an executable `kay build --compile` wrote, the root, routes and public directory it was built with win over both.
- It must `export default` its config, or the command fails with a message saying so.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  routes: 'src/routes',
  lang: 'en',
  minify: true,
  prefetch: 'moderate',
  plugins: [],
})
```

- A directory inside the project holding a `kay.config.ts` of its own, such as an example app or a documentation site, is another project: its components are never the outer one's islands, and it checks and builds from its own root.

- `proxy: false` is none, `proxy: true` is one proxy in front, `proxy: 2` two, `{ header }` a header the proxy sets ([Production](proxy-and-security.md#behind-a-proxy)).
- `extensions` lists what libraries add to the app, one value each, such as `extensions: [auth()]`: pages laid over `src/routes` and API modules over `src/api` under a prefix, message catalogs under `src/messages`, an app file at the same path or an app key winning, config laid under the app's, such as Bun plugins or head tags (see [Extensions](component-libraries.md#extensions)), and a hook rewriting each prerendered page (see [Page hooks](prerendering.md#page-hooks)).

- `minify` is on for `kay build` unless set to `false`, and off for `kay dev` and a server bundling at boot unless set to `true`.
- `lang`, the `<html lang>` of every page when `i18n` is not set, defaults to `en`.
- `typography: false` leaves a French page's spaces before `: ; ! ?` and inside `« »` as typed instead of making them non-breaking ([Locales](locales.md#french-typography)).
- `links: { outside: 'same-tab' }` keeps a link to another origin in the same tab, where it opens in a new one by default ([Navigation](navigation.md#navigation)).

- Every page carries speculation rules, which the swap replaces on pages shipping its script (see [Navigation](navigation.md#navigation)): Chromium prefetches the page a link points at once it is hovered (`prefetch: 'moderate'`), on press with `'conservative'`, as soon as it can with `'eager'`, never with `false`.
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

- It includes `src`, `tests`, the `*.config.ts` files beside it, such as `kay.config.ts`, `eslint.config.ts` and `pg-orm.config.ts`, and `.kay/types`, relative to the project's tsconfig.
- A project adds its own `compilerOptions` beside `extends`, and an `include` of its own replaces kay's, so it lists `.kay/types` again; one setting up its tsconfig by hand needs `"jsx": "preserve"`, `"jsxImportSource": "kay"`, `"module": "Preserve"`, `"moduleResolution": "bundler"` and `"rootDirs": [".", ".kay/types"]`.

- `kay/html`, `kay/dom`, `kay/dom-image`, `kay/pending`, `kay/island`, `kay/await`, `kay/client`, `kay/arrival`, `kay/internal`, `kay/internal/title` and `kay/internal/server` are what compiled `.kay` files and kay's generated entries import, and `kay/jsx-runtime` is where TypeScript finds the JSX types of `jsxImportSource: "kay"`: the compiler's output contract rather than API, free to change in any release, never imported by an app.
- `kay/library` is what kay's own libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms, kayjs-ai) share with kay for their server code, such as the sanitizer's lists, sealing, locale matching, escaping and the user a library names for a request (`nameUser(request, () => id)`, read back by `userOf(request)`: kayjs-auth names the signed-in user and kayjs-ai counts them), so neither keeps a copy: not API either, free to change with any minor, never imported by an app.

### Commands

- `kay new` and `kay add` are in [Scaffold with kay new and kay add](project-new-and-add.md).

- The other commands: `kay dev` is in [The dev server](dev-server.md), `kay build` and `kay start` in [Building and starting](build-and-start.md), and `kay check`, `kay render`, `kay screenshot`, `kay routes`, `kay env`, `kay doctor`, `kay i18n`, `kay upgrade`, `kay explain`, `kay fmt`, `kay lint`, `kay types`, `kay lsp` and `kay mcp` in [Check, inspect and tool commands](check-and-tools.md).
- `kay migrate astro [dir] [--outdir <dir>] [--format text|json] [--quiet]` (`--out` is the older spelling of `--outdir`, an error beside it when the two name different directories):
  - Translate an Astro project's `.astro` files into `.kay` ones, `src/pages` into `src/routes` (`404` as `_404`, `500` as `_error`), components and layouts kept in their folder with kebab-case names and the imports of them rewritten, and `src/content.config.ts` into kay's, its zod schemas written in `s`.
  - The frontmatter becomes the fence, a page's `--- server` with `Astro.url`, `params`, `cookies` and `redirect` read from `ctx`, `Astro.props` becomes `props<Props>()`, and the markup the indented template: static classes as the `.class` shorthand, `class:list` as `class`, `&&`, ternaries and `.map` as `if` and `for`, slots as `slot` and `@name` blocks, `client:idle` and `client:visible` as `hydrate`, `set:html` as `innerHTML` through `trustHtml`, a layout's `head` as a `head` block.
  - It writes into the project, or into `--outdir`, never over a file that exists, formats what it writes, and lists what it could not translate at its line in the Astro file: a script Astro bundles, an `await` or `Astro.url` in a component, an endpoint, markup written another way, each commented out under a `// kay migrate:` line where it stays in the code, and Tailwind 3, as kay builds with Tailwind 4.
  - An `--outdir` directory with no `package.json` gets the kay project around the pages, as `kay new` writes it without its home page, layout and stylesheet: a `package.json` with kay's scripts and the Astro project's packages, Astro's own left out, a `kay.config.ts` with the `site` and `base` of the Astro config and the layout's `<html lang>`, without `seo` defaults since the pages write their own head, a `tsconfig.json` keeping its `paths`, a server entry when the Astro config renders on demand (`output: 'server'` or an `adapter`), a static site otherwise, and Tailwind, ESLint, the Forgejo workflow and the Dockerfile when the Astro project had them;
  - Its other files under `src` and `public` are copied as they are, but for `src/env.d.ts`, which only Astro reads, those beside the pages moving with them into `src/routes`, where kay routes only `.kay` and endpoint files.
  - Beyond the `.astro` files: a script or markup after the layout's `</html>` is kept, `<Icon name="set:name" />` from astro-icon becomes the icon imported from `~icons/set/name`, a `?raw` import takes `with { type: 'text' }`, and the Fontsource stylesheets a file imports become `fonts` entries in the `kay.config.ts` it writes (listed instead when migrated in place); `Astro.self`, `import.meta.env` (in `.astro` files and in `src` modules), a script from another host (kay's Content-Security-Policy blocks it until `security.csp` allows it) and UnoCSS (its packages are left out, its classes pass through) are listed. The `.gitignore` it writes keeps the Astro project's own entries, its ESLint packages are left out for `@kaynooo/eslint`, and a carried `@kaynooo/*` range is listed, as the registry may hold no version in it.
  - A Markdown page in `src/pages` is listed, to become a content collection's entry, and so is a `site` or `base` written as anything but a string.
  - Migrated in place, the Astro project's `package.json` stays as it is, listed with the Astro packages to remove, and the `lang`, `site`, `base` and tsconfig `paths` are listed to carry over by hand.
- `kay migrate content [dir]`: rewrites the files of folder collections whose `migrations` carried entries over ([details](content-cms.md#loaded-collections)).
- Every command prints its usage for `--help` or `-h`, and refuses an option or argument it does not take with `kay <command>: unknown option --x` (naming a near option for a typo) and that command's usage line alone; `kay --help` and an unknown command list every command.
- `kay add`, `kay build`, `kay check`, `kay dev`, `kay fmt`, `kay migrate`, `kay new` and `kay types` take `--quiet`: the problems and one summary line (`kay build` one per step it ran, `--static` and `--compile` adding theirs), without the size report, the files one by one or the next step; `kay fmt --check` names the unformatted files alone; `kay dev` its ready line and errors, no line per restart or stylesheet swap; `kay types` nothing; every other command refuses it.
- Colour only goes to a terminal, never under `NO_COLOR` or `TERM=dumb`, and `FORCE_COLOR` brings it back to a pipe; a redrawn line or a cleared screen only ever goes to a terminal.
- `kay build`, `kay routes`, `kay env`, `kay doctor`, `kay i18n missing`, `kay explain`, `kay fmt`, `kay migrate`, `kay not-found` and `kay screenshot` take `--format json`, as `kay check` does: stdout holds one JSON document on one line, what the app's own code prints through the console or `process.stdout` going to stderr (a write straight to file descriptor 1 is not caught), and the exit code is the text output's.
  - `kay build`: `{ errors, warnings, problems }` as `kay check` prints them, a template that does not compile at its place and any other failure as one problem with `code: null`, then `failed: { stage }` when a stage stopped it, `built: { islands, stylesheets, prerendered, entries, ms, sizes, routes, stages, caches }` (`sizes` the entry's and each island's `raw` and `gzip` bytes, `modules` under `--analyze`, and per island `why` it is one and `promoted` for a static component that only may be; `routes` each route's `js` and `css` gzip bytes, the `islands` its pages render, `pages` prerendered, `kept` pages the build kept on its own and for a route rendered per request the `stop` that decided it and whether the scripts are an `estimated` reach; `stages` `{ name, ms }`; `caches` `{ name, cached, made }`), `exported: { pages, files, dir, ms }` and `compiled: { executable, ms }`; code that ends the process mid-build leaves the problems so far, one saying it ended and the stage, and exit code 1 for its `process.exit(0)`; `--format github` annotates the check's problems as `kay check` does, and a template that does not compile or a failed stage too.
  - `kay routes`: `{ routes, unlisted }`, each route's `methods`, `path`, `kind`, `by`, and `file`, `notes`, `layouts`, `guards` when it has them, every locale's copy with its chains.
  - `kay doctor`: `{ checks }`, each check's `name`, `ok`, `message` and, on a failure, `fix`.
  - `kay env`: `{ variables, unread }`, and `findings` (problems, as `kay check` prints them) with `--compose`, `--example` or `env` in the config, each variable's `name`, `source`, `type`, `required` (`'always'`, `'production'` or `false`), and `default`, `description` and `secret: true` when it has them; `unread` the `file` and `error` of each module that failed to load.
  - `kay explain`: `{ groups, lints, errorGroups, errors }` with each lint's `name`, `group`, `level`, `since` when it has one and whole `summary`, and each error code's `name`, `group`, `summary` and `fix`; the errors only without a lint group named; or one lint's fields, its `wrong` and `right` examples included.
  - `kay fmt`: `{ errors, warnings, problems, written, changed }`, what does not parse as problems.
  - `kay migrate`: `{ written, kept, copied, notes }`, each note's `file`, `line`, `target` and `message`.
  - A command that cannot run, options that do not go together included, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`.
