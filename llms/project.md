# Project setup and commands

## Common tasks

### Start a project

`kay new` scaffolds a project that already checks, builds and runs, from a preset (`blank`, `server`, `site` or `app`) plus the features added or dropped:

```sh
bunx -p @kaynooo/kayjs kay new my-app --template app --without ws
```

### Run the dev server

`kay dev` runs one server process for the whole session: a change to a template, island, loader or API route imports what changed again in that process and swaps the routes in place, and only a change it cannot (the config, the entry, a module the entry or other code imports) starts a new process, from cold. So does a process that grew 64 MiB over its reloads, or took 200 of them, as Bun caches the code of the ES modules it evaluates again, up to a cap that this growth reaches first. Each reload lets go of what the modules that run again opened: the `process.on` listeners, `setInterval` timers and `Bun.SQL` pools they created themselves, and the `sqliteRooms`, `sqliteCache`, `sqliteRates`, `sqliteJobs` and unnamed SQLite session stores, so an edit leaves one of each, not one more. What a library opens for them and a `bun:sqlite` `Database` stay open: open those in a module that does not run again, or close them in `onStop`. It refreshes the open pages and shows errors in the browser:

```sh
kay dev --port 4000 --open
```

### Check the project

`kay check` type-checks the project, `.kay` files included, and fails on errors, and on warnings with `--deny-warnings`, which the `check` script `kay new` writes leaves out:

```sh
kay check --deny-warnings
kay check --fix
kay check --format github
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

### Build and serve for production

`kay build` bundles the islands and stylesheets into `.kay/client`, and `kay start` serves that build as the deployed server would:

```sh
kay build
kay start --port 8080
```

### Build one executable

`--compile` bundles the server, the pages and the client build into a single file that runs from anywhere:

```sh
kay build --compile server
PORT=8080 ./server
```

### Export a static site

`--static` writes the whole site to a directory for a host with no server:

```sh
kay build --static --outdir dist
```

### List the routes the project serves

`kay routes` lists pages, actions, endpoints and API routes without running a page or a guard:

```sh
kay routes
```

### Check what a page renders

`kay render` prints the HTML the server answers for one URL, as `kay dev` serves it, without starting a server; what the server logs goes to stderr, and a status of 400 or above exits 1:

```sh
kay render /about
kay render /account --cookie session=…
```

### Give an agent kay's tools

`kay mcp` serves the project in the current directory as an MCP server over stdio, for an agent to call instead of running `kay` in a shell. It needs nothing in the app: the agent's client starts it from the project's root, where kay is installed.

```sh
claude mcp add kay -- bunx kay mcp
```

Another client takes the same command in its MCP config, such as `.mcp.json` at the project's root for Claude Code (a client may name the key `servers`):

```json
{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }
```

The tools are `check` (`paths`, `only`, `denyWarnings`), `routes`, `explain` (a lint or an error code, `name`), `render` (`url`, `method`, `body`, `headers`, `cookies`) and `dev_errors`; the resources are `kay://llms.txt` and one `kay://llms/<file>.md` per guide, each listing its sections. See [Commands](#commands).

### Format the templates

`kay fmt` formats `.kay` files, and `--check` lists the unformatted ones and fails:

```sh
kay fmt
kay fmt --check
```

### Move an Astro project over

`kay migrate astro` translates the `.astro` files into `.kay` ones, writing into `--out` and never over a file that exists:

```sh
kay migrate astro ../my-astro-site --out ../my-kay-site
```

## Reference

### Project setup

- kay is published as `@kaynooo/kayjs` to the registry at `https://git.kaynooo.fr/api/packages/kaynooo/npm/` and installed under the name its imports use: `"kay": "npm:@kaynooo/kayjs@~<version>"` in `package.json`, a tilde since a minor release may break what the one before it took, each break listed in [Upgrading](upgrading.md), and a major is a rewrite, with `@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/` in the project's `.npmrc`.
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

- `extensions` lists what libraries add to the app, one value each, such as `extensions: [authPages()]`: pages laid over `src/routes` and API modules over `src/api` under a prefix, message catalogs under `src/messages`, an app file at the same path or an app key winning, config laid under the app's, such as Bun plugins or head tags (see [Extensions](components.md#extensions)), and a hook rewriting each prerendered page (see [Page hooks](routing.md#page-hooks)).

- `minify` is on for `kay build` unless set to `false`, and off for `kay dev` and a server bundling at boot unless set to `true`.
- `lang`, the `<html lang>` of every page when `i18n` is not set, defaults to `en`.

- Every page carries speculation rules, which the swap replaces on pages shipping its script (see [Navigation](islands.md#navigation)): Chromium prefetches the page a link points at once it is hovered (`prefetch: 'moderate'`), on press with `'conservative'`, as soon as it can with `'eager'`, never with `false`.
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

- `kay/html`, `kay/dom`, `kay/island`, `kay/await`, `kay/client`, `kay/internal` and `kay/internal/server` are what compiled `.kay` files and kay's generated entries import: the compiler's output contract rather than API, free to change in any release, never imported by an app.
- `kay/library` is what kay's own libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms) share with kay for their server code, such as the sanitizer's lists, sealing, locale matching and escaping, so neither keeps a copy: not API either, free to change with any minor, never imported by an app.

### Commands

- `kay new <dir> [--kay <dependency>] [--template blank|server|site|app] [--with <features>] [--without <features>] [-y] [--quiet]`:
  - Scaffold a project in an empty directory.
  - A project is a set of features: `server` (an Elysia server; off, a static site), `starter` (a header, a skip link, a `_404.kay`, a home page greeting from the server with a counter island), `tailwind` (Tailwind through `bun-plugin-tailwind` over the Catppuccin Mocha palette; off, the markup carries no classes), `accents` (an accent picker in the header, kept in a cookie, which needs `starter` and `tailwind`), `eslint`, `tests`, `ci` (the Forgejo workflow below), `docker` (the container below), `auth` (the app's sessions, sign-in and members, which needs `server`) and `ws` (the app's API module and websocket island, shown on the home page, which needs `server`).
  - A preset names a set: `blank` none, one layout and one bare page built as a static site; `server`, `site` and `app` as described below.
  - Run in a terminal with none of `--template`, `--with`, `--without` or `-y`, it asks for a preset, then shows its features as a checklist, checking a feature checking what it needs and unchecking one unchecking what needs it;
  - Otherwise it takes `--template`, `server` by default, adds the comma-separated `--with` features and drops the `--without` ones, and refuses a feature listed in both, or one missing what it needs (`kay: accents needs tailwind: add --with tailwind, or drop it with --without accents`);
  - Every project has the `.npmrc` naming the registry kay comes from.
  - The `server`, `site` and `app` presets have a layout with `seo` defaults and a skip link, a header with an accent picker over the Catppuccin Mocha palette, kept in a cookie, Tailwind through `bun-plugin-tailwind`, and Tabler icons.
  - `server`, the default, is an Elysia server, with a `Dockerfile` and `compose.prod.yaml` running the executable `bun run compile` makes.
  - `site` is a static site whose `bun run build` runs `kay build --static`, its pages showing the default accent until the picker hydrates, since no server reads the cookie, with a Forgejo Pages workflow publishing `dist` to the `gitea-pages` branch under `/<owner>/<repo>`, its `SITE_URL` a placeholder to replace with the host the Forgejo instance publishes Pages on, and a `Dockerfile` serving it with nginx instead.
  - `app` is the server with sessions, a demo sign-in action, under any name, which production refuses unless `DEMO_SIGN_IN=true`, keeping its members in Postgres through `@kaynooo/pg-orm`, a guarded `/account` section, an API module and an island over its websocket, its session secret and development database written to a `.env` git ignores, `.env.test` holding a test-only secret and the test database, and `.env.example` naming what production sets;
  - `docker compose up -d --wait` starts the database `compose.dev.yaml` describes, `bun run db:migrate` applies `migrations/`, `bun run db:generate` writes the next migration from the tables in `src/db/`, its `bun run test` gives each test file a copy of the migrated, seeded database (see [Testing](testing.md)), its workflow runs Postgres as a service, and `compose.prod.yaml` runs the database and a one-shot service applying the migrations before the app. Two Postgres roles split the work: the owner (`POSTGRES_USER`, connected by `MIGRATE_DATABASE_URL`, which `pg-orm.config.ts` reads before `DATABASE_URL`) changes the schema, and `app_rw` (the app's `DATABASE_URL`, password `APP_DB_PASSWORD`) reads and writes rows and cannot drop, alter or create anything. The database image creates `app_rw` from `db/roles.sh` when it first creates the database, with default privileges on tables, sequences and schemas, so a table a later migration creates needs no `GRANT`. An existing database runs `db/roles.sh` once, see [Upgrading](upgrading.md);
  - Every server preset's compose publishes the app on 127.0.0.1 alone, for a reverse proxy serving it over HTTPS, its images and workflow use the Bun `kay new` ran under, and `.env` is ignored by git and docker and written readable by its owner alone;
  - `--kay` sets the `kay` dependency, by default `npm:@kaynooo/kayjs@~<its version>`, or a packed copy when run from a checkout of kay.
  - The package is named after the directory, lower case with other characters turned into `-`.
  - Every template's `tsconfig.json` adds `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch` to `strict`, as kay does itself, so an optional field passed `undefined` must say `?: T | undefined`;
  - `server` and `app` carry a Forgejo workflow checking, linting and testing the project on every push, and the `site` workflow tests it before building, which checks it, then lints it (see [Linting](checks.md#linting)).
  - Every project also has an `AGENTS.md` pointing coding agents at kay's docs for the installed version, through a `@node_modules/kay/llms.txt` line Claude Code expands at the start of a session, and naming the checks its scripts run; a project without one adds it by hand.
- `kay dev [dir] [--entry <file>] [--port <port>] [--host[=<address>]] [--inspect[=<address>]] [--open] [--format text|json] [--quiet]`:
  - Run the server entry (default `src/server.ts`) of the project in `dir`, or, with no file there, as in a `site` project, a server of kay's own serving its pages on `PORT`, 3000 by default, until a `src/server.ts` is written, the current directory by default, where a file given instead of `dir` is taken as the entry, and `--entry` is relative to the current directory, as `build`'s is, with `NODE_ENV=development`, and `PORT` set to `--port` when given, over the shell's and the `.env`'s, which a server reading `PORT` listens on;
  - A port another process holds moves the server to the next free one, however the server picked it, `--port` included, the ready line naming the port in use, and every restart keeps the port it moved to;
  - A server naming no `hostname` listens on `localhost` alone, so nothing past this machine reaches it, unless `--host` opens it to the network (`--host` alone is `0.0.0.0`, `--host=<address>` one address), as `kay dev` in a container publishing its port needs;
  - A request whose `Host` is not `localhost`, a `*.localhost` name, an IP address or the site's host gets 421, as a page of another site renaming itself to this machine (DNS rebinding) would send it; `--host` adds this machine's own name and `<name>.local`, and other names, such as a tunnel's, go comma-separated and without ports in `KAY_DEV_HOSTS`;
  - `--inspect` opens Bun's debugger in every server it runs, at `ws://localhost:6499/kay` or the port, host and port, or address given, port 0 taking a free one, on that one address across restarts so a debugger reconnects, printed once under the ready line with its `debug.bun.sh` link, `kay dev` listening there itself and passing each connection on to the server running, which stays open across a reload and closes when the server restarts in a new process, an address another process holds, at `localhost` on either loopback address, stopping `kay dev`, an address past this machine refused unless `--host` is given too, and a page reaching it only from the dev server's own `localhost` origin or `debug.bun.sh`;
  - `--open` opens the address in the browser, the command `BROWSER` names or the system's, once the first server listens, reloading it on every change but to tests (`tests/`, `test/`, `e2e/`, `__tests__/`, and `*.test.*` and `*.spec.*` scripts anywhere) and to root files no server reads, such as a README, a LICENSE or a justfile, or to the backup, swap and temporary files editors write beside a source, one save restarting once however the editor writes it;
  - Open pages refresh by themselves, an edit to `.css` files alone restarts nothing and swaps the new stylesheets into the open pages, and a project that fails to compile shows its errors in the browser, and in the terminal once as the server boots, formatted as `kay check` prints them; a request that throws prints its error in the terminal, its stack mapped to `.kay` lines.
  - A page that throws, with no `_error.kay`, or a server that failed to boot shows an error page following the system's light or dark theme: the message, the lines around where the project's own code threw, its frames, those of kay and the dependencies folded, and a Copy button for the message and stack;
  - Under `kay dev` each frame and compile error position opens in the editor on a click.
  - A problem kay recovers from in the browser, such as an island that did not match its server markup or had no client chunk, or a message no locale has, shows in the console and in the dev tool every dev page carries, a bar at the bottom left of the page counting the problems, red when one is an error, whose drawer (a click on the bar, or Alt+Shift+K; Escape closes it) lists them under Problems, grouped by kind, with an error nothing caught, one kay caught in an island or an effect, or an unhandled rejection, and its stack, and each source the Content-Security-Policy blocked, a problem logged again counted rather than repeated;
  - A `.kay` file a problem names opens in the editor on a click under `kay dev`, and hovering an accessibility problem outlines the elements it names.
  - Dismiss, or Dismiss all, hides a problem for the rest of the browser tab, until its text changes, and those the page logged go when it is left.
  - Its Request tab shows what served the page: the route it matched, the page and its layouts, the params, the locale, the status with the error a special page shows, and each load's time, as `Server-Timing` has it, with whether `kay build` prerenders the page, each guard that ran and what it did (passed, redirected, denied, or did not run after a refusal), the redirects the request went through before it and which guard, `redirects` entry or setting made them, the server's time to answer and the response headers, the CSP and cache-control first, all read off what the server did on that request, a page swap showing the next page's;
  - Its Head tab shows the page's head as it is now: the search result it makes, its title and description with their length and the description's limit of 160 characters, the canonical link, hreflang alternates, the robots tag, whether the sitemap lists the page, the og and twitter tags with a preview of the social card image, and each JSON-LD block parsed or with its parse error; what `kay check` would flag in a built page's head shows as a problem, and with `seo` set but no origin it says there is no canonical link or sitemap; it reads again after each page swap;
  - Its Routes tab lists every page, endpoint and API route the server serves, each locale's copy of a page on its own line, filtered by path or file, a path no request fills in linking to itself, fetched again after each restart; a section of what kay serves itself lists the sitemap, robots.txt, feeds, manifest, favicons, service worker, health check and a library's dev pages such as kayjs-mail's `/_kay/mail`, only those the running server serves, so a path an app file took over shows as the app's, and with `seo` set but no origin it says why there is no sitemap or robots.txt;
  - Its Env tab lists each variable `publicEnv` sends the browser, read from `/_kay/env.js` with its value, flags one whose name or value looks like a secret (secret, password, token or database URL names, a URL with a password, a well-known token prefix, a hexadecimal or random string), only noting a name ending in `_KEY`, which may be public by design, and says when the app sends no public env; the server's own env is never shown;
  - Its Images tab lists each image of the page with the variant it got (a ladder width, a crop, the share card, or not resized by kay), the format and bytes the server answers with (a HEAD request, only for a loaded image of kay's image route or built variants, with a timeout; any other image is not asked), the size served against the size drawn (flagged past 4 times the pixels shown), the largest contentful paint, and an image without `width` and `height` or lazy-loaded while in view; hovering or focusing a row outlines the image, and the list follows the page as images change;
  - Its Performance tab shows the page load's LCP (with its element), CLS and INP as the browser reports them while the page is used, each rated against its good limit (2.5 s, 0.1, 200 ms) and naming the page they were measured on once a swap moved away from it, and the HTML (the document the browser holds, not fetched again), CSS and JS gzipped, measured again after a swap, with the entry, the islands' chunks and the other chunks apart; the sizes are dev sizes, not minified, larger than `kay build` makes them, and a "Last kay build" block gives the route's scripts and stylesheets from the report `.kay` keeps (its age, `~` for an estimate, nothing before a first build);
  - Under `kay dev` a file either names opens in the editor on a click.
  - Under `kay dev`, the bar says for a few seconds after each restart or stylesheet swap what changed and how long it took, as the terminal does, the page it reloaded included, without taking the focus; an edit that does not compile reloads the open pages into the error page instead.
  - The drawer follows the system's light or dark theme, docks left or right, and keeps its open tab and side for the browser tab across page swaps and reloads; production pages never carry it.
  - The dev tool lists too what `kay check` reports of the project's `.kay` files without type checking, such as an `img` without `alt`, an unread prop or a browser global read while rendering; type errors and unchecked links still wait for `kay check` or the editor.
  - It lists as well each accessibility rule the rendered page breaks, such as text too faint on its background, as axe-core finds it once the page settled (see [Checks and lints](checks.md#checks-and-lints)).
  - When only island components changed, an open page swaps each edited island in place, and each island rendering it inside, instead of reloading: the rest of the page, its other islands and its form fields stay as they were.
  - The swapped island is built afresh, so what it does not hold in signals, such as an unbound input's text or the focus inside it, starts over; the signals its script creates keep their values, matched in the order it creates them, until one whose initial value is of another kind, as after adding a signal before it.
  - Signals made inside a `for` row, an `if` or `await` block, or by kay itself start afresh; two signals of one kind swapped in the script trade values.
  - A change to anything else, a page, a layout, a static component, a `.ts` module or a deleted source file, or an island edit that cannot swap in, refreshes the open page through the page swap once the server restarted, as `refresh()` does: the scroll, the islands whose props did not change and their state stay, a field the edit leaves as it was keeps what was typed into it (one the edit removed, renamed or gave another rendered value shows what the page renders), and the rest of the page is rendered afresh.
  - When the browser build changed under the page, as after a new island or an edit to a module islands share, the swap loads the page fully rather than run old code beside new, as a server that failed to boot always does.
  - A page without the page swap (`navigation: false`) keeps the server render it loaded with and, once the server restarted, applies only what changed between it and the new render to the page: a node whose markup did not change stays as it is, with the classes, the transitions, the focus and the scroll scripts gave it, and an edited element has its attributes, text and children changed in place, a class by its names so one a script added stays.
  - The page loads fully instead when that cannot apply, as when an island, a script, the `html` attributes or a streamed `await` block changed, or the page holds something its render did not.
  - None of it is in a production build.
  - Island chunks carry source maps, so the browser's devtools show and break on `.kay` lines.
  - A server process started from cold loads kay and registers its `.kay` loader for the project with the settings of its `kay.config.ts`, so what the entry imports before it calls `pages()`, such as a mailer rendering `.kay` mails, loads `.kay` files, `~icons` and `import.meta.glob` as pages do, a `pages()` naming another root or other settings starting the loader over;
  - Compiled files are kept in `.kay/cache`, so a restart compiles only the file that changed; `kay build` drops the entries of components and content files since deleted, and keeps the favicons it drew and the compressed copies of each file by content, drawing and compressing only what changed.
  - `kay dev` builds the browser code itself while the server boots, in a process it keeps from one change to the next, and the server reads that build as a production server reads `kay build`'s;
  - An edit builds again only what it reaches: the islands when it touched a module of theirs or added or removed one, the stylesheets when it touched a stylesheet, the pages, a page's imports or, with a config plugin such as Tailwind, the classes, a word Tailwind makes no class of, as in prose, leaving the stylesheets as they are, so a change to a server module reloads the server alone.
  - A `pages()` given options for the browser build that `kay.config.ts` does not hold bundles its own as it boots, with a warning, so those options belong in `kay.config.ts`.
  - That browser build goes to `.kay/dev`, not `.kay/client`, so a `kay build` or a test run beside it leaves the files its pages link in place.
  - A change to a file at the project root, such as `.env` or `package.json`, starts a fresh process, which reads the new `.env` values (variables set in the shell still win, unless they equal the file's value).
  - The terminal shows the address of the first server the entry starts once, as `kay dev: http://localhost:3000 (ready in 412 ms)`, or `(ready in 412 ms, 3000 was in use)` when it moved, then one line per restart, as `14:02:31 src/routes/index.kay: restarted in 58 ms`, with `, now on <address>` when the address changed, or per stylesheet edit, as `14:02:47 src/app.css: stylesheets swapped in 24 ms`, and `the server exited with code 1, waiting for a change` when the server exits on its own; on a terminal, a restart or swap line the same as the one before, nothing printed between, is rewritten with a count, `(x3)`, unless the app printed between, though output it writes natively, bypassing `console` and `process.stdout`/`process.stderr`, is not seen; while piped every line stays; `--quiet` leaves out the keys line and the restart and stylesheet lines, a restart that moved the address excepted, and under `--format json` the same `restart` and `styles` events;
  - Under `--host` listening on every address, a second line names the address this machine is reached at on its network, as `kay dev: http://192.168.1.20:3000 on the network`. It prints piped too, and it names the first interface no container, bridge or VPN made, on Linux and macOS alike.
  - In a terminal, `kay dev` lists its keys under the ready line and reads them: `o` opens the address in the browser, `r` restarts the server in a new process, its line saying `r pressed`, `c` clears the screen and `q` or Ctrl+C quits, while Ctrl+Z reaches it as a key too and does not suspend it; piped, or under `--format json`, it reads no key and prints no such line.
  - kay's own start line, `kay: listening on <address>, ...`, only shows in production, and an entry's own `console.log` of `Listening on <that address>` is left out.
  - `--format json` prints each of those as one JSON object per line on stdout, `{ "event": "ready", "time", "url", "ms" }`, with `network` under `--host`, then `restart` (`changed`, the files, `ms`, `url`), `styles`, `exit` (`code`), `debugger`, `no-browser` and `builder-exit`, and an `error` event for each error `.kay/dev/errors.json` lists, its fields as there, the servers' own output going to stderr instead.
  - `.kay/dev/errors.json` lists, as `{ "errors": [...] }`, the errors the servers met, for a reader without a browser such as a coding agent: why the server failed to boot (`kind` `compile`, each problem's `file`, `line`, `column`, `code` and `message` in `problems`, or `boot`), a request that threw (`request`, its `method` and `path`) and an error an island met in the browser (`browser`, its page's path, `island` its component), each with `time`, `message`, `report` (the compile errors as `kay check` prints them, a request's stack on `.kay` lines, or a browser's stack as it sent it) and, where the project's own code threw, `at`: its `file`, `line`, `column` and `frame`, the lines leading to it.
  - A boot failure goes once a server boots, a request's error once that method and path are answered without one, and a browser error once its page is served again; requests' errors stay across restarts, the latest 50 kept, and a server not run by `kay dev` writes none, nor does an entry that throws before it calls `pages()`.
  - Under `kay dev`, every element a `.kay` template writes, but the head's, carries `data-kay-src="<file>:<line>:<column>"`, and every page loads the inspector: holding Alt outlines the element under the pointer with that position, from the moment Alt is pressed, Alt+click opens it in the editor, the dev tool's Inspect button does what Alt does until the next click or Escape, for a system taking Alt+click, and its Islands tab, counted on the bar, lists each island's component (a click opens it) with the values its signals hold now, numbered in the order its script creates them, refreshed twice a second while the tab shows.
  - The editor is `KAY_EDITOR` (a command, getting the position the way the editor among its words takes it, VS Code, Cursor, Zed, Sublime Text, JetBrains IDEs, code-server, Vim, Neovim and Helix included, as in `tmux new-window nvim`, else the file appended), else `VISUAL` or `EDITOR` when they name one of those that opens a window, else the first of them found on the `PATH`;
  - On a Linux machine with no display, as one reached over SSH, only code-server counts, opening the file in its window already open on the project.
  - With none, the page says so and the terminal prints the position; an editor command exiting with an error within 2 seconds prints its error in the terminal and the page says it failed.
  - A server run any other way, `pages({ dev: true })` included, has the dev tool without the inspector, and a production build has neither.
- `kay build [dir] [-p tsconfig.json] [--no-check] [--analyze] [--format text|github|json] [--quiet]`:
  - Bundle the islands and stylesheets for production, whatever `NODE_ENV` the shell holds and with none of the server's secrets, such as `preview.secret`, needed, minified, into `.kay/client` while checking the project as `kay check` does, `-p` naming the tsconfig as there;
  - Once the check passed, render the pages marked `prerender`, so no page, API module or guard runs before then.
  - With the check on, a problem it reports, check-only ones included, or a build that fails leaves the last build in `.kay/client` as it was; `--no-check` skips the check and builds in place.
  - Then start the server with `NODE_ENV=production`, as `kay start` does.
  - Each page preloads the chunks of the islands it renders. kay's runtime, all any island uses of it included, is the one chunk a page loads first, so a page with islands loads that chunk and one per island, plus one for code several islands import.
  - In a terminal, one line on stderr redrawn in place names the step running, its time, and a bar with a count for the routes it prerenders and the images it encodes, cleared before anything else prints and on Ctrl-C; with stdout or stderr piped, under `NO_COLOR`, on a `TERM=dumb` terminal or with `--format github|json`, no such line and no control code.
  - The build prints what that weighs, gzip then minified: the entry every page with an island loads, then what each island adds beyond it, the heaviest first; `--analyze` also names the five modules weighing most in each, a package's files counted as one, kay's runtime file by file.
  - After the islands it prints one row per route, the heaviest first (at most 25, then a count): its pattern, whether it was prerendered (and how many pages), and the gzip scripts and stylesheets it loads; for a route no page of which was prerendered the scripts are marked `~`, the entry and every island its components can reach (through helpers, dynamic imports and aliases, a shared chunk counted once, the entry added when a form posts to an action or a server island is deferred); a route whose pages all answered a status other than 200 counts as prerendered. A route, island or entry the last build had and this one lacks is listed under `Removed since the last build:`. It then prints the time each stage took (check, bundle, prerender, route sizes, images and cards, favicons, page hooks, compress) and, per cache under `.kay/cache`, how many entries came from it and how many were made (`components`, `analyses`, `image variants`, `share cards`, `favicons`, `compressed copies`, `package probes`, `runtime chunk`). Each size shows its change since the last build as `[+3.2 KB]`, `[new]` for a row it did not have, nothing when it did not change; the sizes of the last successful build of the same kind (server, in `.kay/report.json`, or `--static`, in `.kay/report-static.json`) are kept, replaced only after a build succeeded. Long paths lose their middle to fit the terminal's width, and no colour or control code is printed. `--quiet` leaves all of this out.
  - Every text file it writes, prerendered pages included, gets a brotli and a gzip copy, sent to a browser whose `Accept-Encoding` takes one, with `Vary: Accept-Encoding`; other responses are compressed by the server in production, unless `compress` is `false` (see [Production](production.md)).
  - It writes `.kay/client/THIRD-PARTY-LICENSES.txt`, served at `/_kay/THIRD-PARTY-LICENSES.txt` and exported with the rest: the licence files of each package whose modules, stylesheets or fonts the browser build ships, and of every `@iconify-json` set the project depends on, those in a `LICENSES` folder included, with a warning for a set whose licence asks for more than that notice, such as CC BY's credit where the icons show. An executable's `./server --licenses` adds its server's packages, and the licences of the codecs the AVIF encoder compiles in.
- `kay build [dir] --compile <executable> [--entry src/server.ts] [--verify]`:
  - The same, then bundles the server entry, every page, layout, special page, guard and API module, `kay.config.ts` and the client build and public files into one executable, which runs from anywhere as the production server would: `PORT=8080 ./server`.
  - `--verify` then starts the executable on a free port, waits for its health route and runs `--health`, failing the build with the server's own output: [Check the executable starts](production.md#check-the-executable-starts).
  - It carries its code as bytecode, so it starts without parsing it.
  - It reads nothing of the project from disk but a `.env` and `bunfig.toml` where it runs, as `bun` would, so a file a page reads at runtime by path, rather than importing it, is not in it; the root, routes and public directory it was built with win over the options given to `pages()`.
  - `--compile` and `--entry` are relative to the current directory.
  - The public directory cannot be named `client`.
  - The executable carries `kay.config.ts` without its `plugins`, nor the imports and top-level declarations only they used, side effects included, so a build plugin such as Tailwind's, whose native addon loads from node_modules, never runs there;
  - Plugins set other than as a property of the object the file exports by default, or beside a spread, stay in, with a warning.
  - `./server --licenses` prints the licence of every package it carries: the browser build's, and every package the project's `dependencies` install, theirs included.
- `kay build [dir] --static [--outdir dist]`:
  - The same, then writes the whole site to `--outdir` for a host with no server; see [Static export](routing.md#static-export).
- `kay start [dir] [--entry <file>] [--port <port>]`:
  - Serve the last `kay build` as the deployed server would, with `NODE_ENV=production`: the executable `--compile` wrote when that build made one (a later build without `--compile` drops it; one older than the build warns), else the server entry, else, in a project with none, kay's own server of its pages.
  - It refuses without a build in `.kay/client`, and warns when a file the server or its build reads changed since, naming the latest; env files are left for the server to read as Bun does under `NODE_ENV=production`, `.env.production` and `.env` both, so a value only `.env` holds reaches it, the shell's variables winning.
  - `--entry` runs another entry, relative to the current directory; `--port` sets `PORT`, over the shell's and the env files', 3000 otherwise.
  - Ctrl-C, `SIGTERM` and `SIGHUP` reach the server once, sent to the group or to `kay start` alone, which waits for it to drain, a second Ctrl-C stopping it at once; `SIGQUIT` is passed on and ends it at once (131).
  - The server runs in a process group of its own: Ctrl-Z suspends `kay start` alone, and once `kay start` is gone, as after a `SIGKILL` to the group, a kay server notices within a second and drains as on `SIGTERM`, or stops once booted when it was gone already;
  - It exits with the server's code, 0 when the server ended on a stop signal it passed on, 128 plus the signal's number when it died of another.
  - The `start` script `kay new` writes runs it.
- `kay render <url> [dir] [--method <method>] [--body <text>] [--header <name: value>]... [--cookie <name=value>]... [-i|--include] [--entry <file>]`:
  - Answer one request as the server entry answers it under `NODE_ENV=development`, as `kay dev` serves it but without the inspector's attributes, and print the body on stdout; the server runs on a Unix socket of its own, not a port, stops once it answered, or starts stopping within a second once `kay render` is killed, and builds the browser code into a directory under `.kay` it removes, never touching `kay build`'s or `kay dev`'s; the next `kay render` removes what a SIGKILLed one left.
  - What the server logs, a page's error report included, goes to stderr; a redirect prints `kay render: 302 Found, to /login` there and exits 0, a status of 400 or above prints its line there and exits 1, and a server exiting before it serves fails with its code.
  - `--body` posts as a form does, `application/x-www-form-urlencoded`, unless a `--header` names another `content-type`; `--header` and `--cookie` repeat, a guarded page rendering signed in with the session cookie a browser holds; `-i` prints the status and headers on stderr.
  - Under `base`, a path under it is taken as the proxy in front of the server hands it over, so a link a page printed renders as it is.
  - The whole app boots for it: its jobs and modules' top-level code run, and a `POST` to an action runs it against the app's database. The request goes to the first server the entry starts, with the host a full URL names, over plain HTTP; a server not listening after 60 seconds fails it.
- `kay check [dir] [paths...] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>] [--format text|github|json] [--watch] [--quiet]`:
  - Type-check the project, `.kay` files included;
  - The first path is the project when it is a directory holding a `kay.config.ts`, `package.json` or `tsconfig.json`, or any directory outside the current directory, so a directory given first to narrow the report must be neither;
  - The other paths, files or directories relative to the current directory, a symlink read as what it points to, narrow the report, and `--fix`, to the problems in them, the project still checked as a whole, and one outside the project fails the check;
  - `--watch` checks again on every change, tests included, each check a `kay check` of its own, so an edit to `kay.config.ts` counts and a check that cannot run, or exits before reporting, leaves the watch going, clearing the previous report in a terminal, and an interrupt or a closed terminal stops the check running and what it started, a second interrupt killing them;
  - `-p` is relative to `dir`, and a tsconfig that is missing or matches no files fails the check.
  - `--entry` names the server entry whose `app` types `ctx.locals` and the app routes, `src/server.ts` by default, as `kay build --entry` does (see [Locals](server.md#locals)).
  - It fails on errors, and on warnings too with `--deny-warnings` (see [Lints and warnings](checks.md#lints-and-warnings)).
  - `--fix` first applies the quick fixes that change nothing else, removing an unread prop or writing `onclick` as `onClick`, then reports what is left; the others, such as a key or a `maxLength` to choose, stay the editor's.
  - `--only seo` prints one group's lints alone, as an audit (see [Lints and warnings](checks.md#lints-and-warnings)).
  - `--format github` prints each problem as a workflow command, `::error file=...,line=...,col=...::message`, which GitHub and Forgejo Actions show on the diff, as the CI `kay new` writes does, its `file` relative to `GITHUB_WORKSPACE`, the repository's root, when set;
  - `--format json` prints `{ errors, warnings, problems }` on stdout, each problem's `file` relative to the current directory with its `line`, `column`, `endLine`, `endColumn`, `severity`, `code` and `message`;
  - A check that cannot run, on a path that does not exist or a `kay.config.ts` that does not load, prints one error in the format too, with no `file` but where a config does not parse;
  - The exit code is the same in every format.
  - It also reports what the server would refuse when it boots, with the same functions: two pages serving one path, a redirect from a path a page serves or with syntax the router refuses, a page under a locale's prefix, a public file a page serves, two files whose actions share a URL (`a b.kay` and `a_b.kay`), a `base`, `site` or `shutdownTimeout` it cannot read, a collection feed without `site`, and a guard, API module or matcher whose default export is not a guard, an Elysia instance or a function.
  - `kay build` reports them as it checks, and the editor after a save or a change on disk.
- `kay routes [dir] [--format text|json]`:
  - List the routes the project serves, without running a page or a guard: each page's pattern with its matchers, `/items/:id=integer`, and file, once per locale's path (`/about`, `/fr/a-propos`), with its layouts and guards, outermost first, `prerendered` with `prerender: true` or a server island, `prerendered as its prerender setting lists` with a list or a function, `open` with `guards: false` and the 403 `requireGuards` gives one with no guard;
  - Each action, endpoint, API module route with its method, `WS` and `OPTIONS` included, and a library's with the guards of its own directory (API modules are imported, as only they know their routes, so their top-level code runs: what it writes to stdout, through the console or `process.stdout`, goes to stderr, and one that fails to load or calls `process.exit()` is listed by its mount with why), the routes of an extension's `server` given as an Elysia instance, each redirect and collection feed;
  - And kay's own routes the config turns on, such as `/_kay/health`, the favicons and the sitemap.
  - What the server entry adds, as a `.use(auth.plugin)`, and an extension's `server` given as a function are only known as the server starts: a last line names them, unlisted.
- `kay explain [lint|error|group] [--format text|json]`:
  - List the lints with their groups and default levels and the errors with theirs, or a group's, or print one: a lint with an example it reports and the same written right, an error with where its fix is written.
- `kay fmt [paths...] [--check] [--format text|json] [--quiet]`:
  - Format `.kay` files; `--check` lists unformatted files and fails.
- `kay lint [keslint arguments]...`:
  - Write the types the lint of `.kay` files reads, as `kay check` does, then run the project's `keslint` with the arguments, so linting needs no check before it; its exit code is `keslint`'s (see [Linting](checks.md#linting)).
- `kay migrate astro [dir] [--out <dir>] [--format text|json] [--quiet]`:
  - Translate an Astro project's `.astro` files into `.kay` ones, `src/pages` into `src/routes` (`404` as `_404`), components and layouts kept in their folder with kebab-case names and the imports of them rewritten, and `src/content.config.ts` into kay's, its zod schemas written in `s`.
  - The frontmatter becomes the fence, a page's `--- server` with `Astro.url`, `params`, `cookies` and `redirect` read from `ctx`, `Astro.props` becomes `props<Props>()`, and the markup the indented template: static classes as the `.class` shorthand, `class:list` as `class`, `&&`, ternaries and `.map` as `if` and `for`, slots as `slot` and `@name` blocks, `client:idle` and `client:visible` as `hydrate`, `set:html` as `innerHTML` through `trustHtml`, a layout's `head` as a `head` block.
  - It writes into the project, or into `--out`, never over a file that exists, formats what it writes, and lists what it could not translate at its line in the Astro file: a script Astro bundles, an `await` or `Astro.url` in a component, an endpoint, markup written another way, each commented out under a `// kay migrate:` line where it stays in the code, and Tailwind 3, as kay builds with Tailwind 4.
  - A `--out` directory with no `package.json` gets the kay project around the pages, as `kay new` writes it without its home page, layout and stylesheet: a `package.json` with kay's scripts and the Astro project's packages, Astro's own left out, a `kay.config.ts` with the `site` and `base` of the Astro config and the layout's `<html lang>`, without `seo` defaults since the pages write their own head, a `tsconfig.json` keeping its `paths`, a server entry when the Astro config renders on demand (`output: 'server'` or an `adapter`), a static site otherwise, and Tailwind, ESLint, the Forgejo workflow and the Dockerfile when the Astro project had them;
  - Its other files under `src` and `public` are copied as they are, but for `src/env.d.ts`, which only Astro reads, those beside the pages moving with them into `src/routes`, where kay routes only `.kay` and endpoint files.
  - A Markdown page in `src/pages` is listed, to become a content collection's entry, and so is a `site` or `base` written as anything but a string.
  - Migrated in place, the Astro project's `package.json` stays as it is, listed with the Astro packages to remove, and the `lang`, `site`, `base` and tsconfig `paths` are listed to carry over by hand.
- `kay lsp --stdio`:
  - The language server behind the editor extension in `editors/vscode`: errors, hover, completion with auto-import, signatures, definitions, references, rename, quick fixes and formatting in `.kay` files.
  - An import it adds goes in the fence the name is used from, the server fence for server code and the component script otherwise, made if missing.
  - Renaming a server value renames its reads in the template, and renaming a destructured prop renames it in every parent passing it.
  - It runs the project's `kay.config.ts`, and the modules it imports, as soon as a `.kay` file is opened, as `bun` would: open only a project you trust, as with its `package.json` scripts.

- `kay mcp [--stdio]`:
  - Serve the project in the current directory to an agent as an MCP server over stdio (newline-delimited JSON-RPC), in both the revision that opens with `initialize` (`2025-11-25` and earlier) and `2026-07-28`, whose requests carry their version in `_meta`; it needs no setup in the app and prints nothing but protocol on stdout.
  - Tools, each with an input schema: `check` runs `kay check --format json` and answers its document, taking `paths` (files or directories inside the project to report on, `.` for all of it; the project is checked whole either way), `only` (a lint group) and `denyWarnings`; `routes` answers `kay routes --format json`; `explain` lists the lints and error codes, or explains the lint, error code or group in `name`; `render` runs `kay render` on `url` with `method`, `body`, `headers` (`name: value`) and `cookies` (`name=value`), answering the body (an image or a blob, unchanged, when it is not text), then the status line, headers and server log, as an error result for a status of 400 or above; `dev_errors` reads `.kay/dev/errors.json` (see `kay dev`), an empty list when `kay dev` has met nothing.
  - Each tool runs the command in a child process of its own, so a call pays what the command costs, a `check` as long as `kay check`; a problem found is a result, a command that could not run an error result (`isError`). Calls run one at a time, in the order they came, and a command that is stopped (timeout, client gone) takes what it started along.
  - Resources: `kay://llms.txt`, and `kay://llms/<file>.md` for each file of `llms/`, with the file's title and the headings of its sections as description; only those are readable.
  - Register it with `claude mcp add kay -- bunx kay mcp`, or as `{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }` in a client's JSON config.
- Every command prints its usage for `--help` or `-h`, and refuses an option or argument it does not take.
- `kay build`, `kay check`, `kay dev`, `kay fmt`, `kay migrate` and `kay new` take `--quiet`: the problems and one summary line (`kay build` one per step it ran, `--static` and `--compile` adding theirs), without the size report, the files one by one or the next step; `kay fmt --check` names the unformatted files alone; `kay dev` its ready line and errors, no line per restart or stylesheet swap; every other command refuses it.
- Colour only goes to a terminal, never under `NO_COLOR` or `TERM=dumb`, and `FORCE_COLOR` brings it back to a pipe; a redrawn line or a cleared screen only ever goes to a terminal.
- `kay build`, `kay routes`, `kay explain`, `kay fmt` and `kay migrate` take `--format json`, as `kay check` does: stdout holds one JSON document on one line, what the app's own code prints through the console or `process.stdout` going to stderr (a write straight to file descriptor 1 is not caught), and the exit code is the text output's.
  - `kay build`: `{ errors, warnings, problems }` as `kay check` prints them, a template that does not compile at its place and any other failure as one problem with `code: null`, then `failed: { stage }` when a stage stopped it, `built: { islands, stylesheets, prerendered, entries, ms, sizes, routes, stages, caches }` (`sizes` the entry's and each island's `raw` and `gzip` bytes, `modules` under `--analyze`; `routes` each route's `js` and `css` gzip bytes, `pages` prerendered and whether the scripts are an `estimated` reach; `stages` `{ name, ms }`; `caches` `{ name, cached, made }`), `exported: { pages, files, dir, ms }` and `compiled: { executable, ms }`; code that ends the process mid-build leaves the problems so far, one saying it ended and the stage, and exit code 1 for its `process.exit(0)`; `--format github` annotates the check's problems as `kay check` does, and a template that does not compile or a failed stage too.
  - `kay routes`: `{ routes, unlisted }`, each route's `methods`, `path`, `kind`, `by`, and `file`, `notes`, `layouts`, `guards` when it has them, every locale's copy with its chains.
  - `kay explain`: `{ groups, lints }` with each lint's `name`, `group`, `level` and whole `summary`, or one lint's fields, its `wrong` and `right` examples included.
  - `kay fmt`: `{ errors, warnings, problems, written, changed }`, what does not parse as problems.
  - `kay migrate`: `{ written, kept, copied, notes }`, each note's `file`, `line`, `target` and `message`.
  - A command that cannot run, options that do not go together included, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`.
- `kay fmt` refuses a path that is missing or is neither a directory nor a `.kay` file.

- The TextMate grammar the extension highlights `.kay` files with ships as `kay/kay.tmLanguage.json`, for a highlighter such as Shiki: register it as `{ ...grammar, name: 'kay', embeddedLangs: ['typescript'] }`.
