---
title: CLI
order: 1
description: The kay commands to scaffold, run, check, build and format a project.
---
`kay dev`, `kay build`, `kay check`, `kay start` and `kay routes` take an optional project directory (the current one by default), and every command prints its usage for `--help`.

Once Bun knows the registry ([Installation](/getting-started/installation#registry-setup)):

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun install
bun run dev
```

| Command | Does |
| --- | --- |
| `kay new <dir>` | Scaffold a project that checks, builds and runs |
| `kay types [dir]` | Write the types the editor's ESLint reads, without checking |
| `kay add <features> [dir]` | Add `kay new` features, or a kay library, to an existing project |
| `kay dev [dir]` | Run the server, restarting on change, with errors shown in the browser |
| `kay build [dir]` | Check the project and bundle the browser code for production |
| `kay start [dir]` | Serve the last build as production does |
| `kay render <url> [dir]` | Print what the server answers for one URL, without starting it on a port |
| `kay check [dir]` | Type-check the project, `.kay` files included |
| `kay upgrade [dir]` | Move kay and its libraries to the latest version and rewrite the old forms |
| `kay routes [dir]` | List every route the project serves, and the file serving it |
| `kay explain [lint\|error\|group]` | List the lints and the errors, or a group's, or explain one |
| `kay fmt [paths]` | Format `.kay` files |
| `kay migrate astro [dir]` | Translate an Astro project into a kay one |
| `kay lsp --stdio` | The language server behind the editor extension |
| `kay mcp` | Serve the project to an agent as MCP tools and resources |

## kay new

```sh
kay new my-app --template app --without docker
```

| Option | Effect |
| --- | --- |
| `--template blank\|server\|site\|app` | The preset: one bare static page, an Elysia server (the default), a static site, or a server with sessions and members in SQLite |
| `--with <features>` | Adds comma-separated [features](#features) to the preset, such as `tailwind,tests` |
| `--without <features>` | Drops features from the preset |
| `--host forgejo\|github` | Where the repository lives, which decides the CI workflow. Without it, `kay new` reads the `origin` remote of the directory, or of the closest one above it that exists |
| `-y` | Takes the `server` preset without asking |

In a terminal with none of these options, `kay new` asks for a preset, then for each feature.

The CI is a Forgejo workflow in `.forgejo/workflows`, or, for a repository on GitHub, a GitHub Actions workflow in `.github/workflows`. A remote on github.com picks GitHub, any other remote or none picks Forgejo, and `--host` overrides it. Both annotate each problem of `kay check` on the diff. A static site is published with GitHub Pages there, its address and base path read from the repository.

Every project gets an `AGENTS.md` for coding agents. It points them at kay's docs for the installed version, `node_modules/kay/llms.txt`, which Claude Code loads at the start of each session through its `@node_modules/kay/llms.txt` line, and names the checks the project's scripts run. A project made before it existed adds it by hand.

### Features

| Feature | Adds | In the presets |
| --- | --- | --- |
| `server` | An Elysia server, run in production as one executable; without it, a static site built to `dist` | server, app |
| `starter` | A header, a skip link, a 404 page, and a home page greeting from the server with a counter island | server, site, app |
| `tailwind` | Tailwind over the Catppuccin Mocha palette; without it, the markup carries no classes | server, site, app |
| `accents` | An accent picker in the header, kept in a cookie; needs `starter` and `tailwind` | server, site, app |
| `eslint` | ESLint through `@kaynooo/eslint`, `.kay` fences and template expressions included | server, site, app |
| `tests` | `bun test` through `kay/test`, with a first test | server, site, app |
| `ci` | A Forgejo or GitHub workflow checking, linting and testing the server, or publishing the static site to Pages | server, site, app |
| `docker` | A `Dockerfile` and `compose.prod.yaml` running the executable, or nginx serving the static site | server, site, app |
| `auth` | Sessions, a sign-in, members in SQLite through pg-orm and a guarded `/account`; needs `server` | app |
| `postgres` | The members in Postgres instead of SQLite, with a compose stack for development and the roles below; needs `auth`, as in `--template app --with postgres` | none |
| `ws` | An API module over a websocket, with an island counting the visitors online; needs `server` | app |

`blank` has none of them. Asked in the terminal, checking a feature checks what it needs, and unchecking one unchecks what needs it. With options, a feature missing what it needs is refused with the flag to add:

```
kay: accents needs tailwind: add --with tailwind, or drop it with --without accents
```

## kay add

```sh
kay add tailwind,accents
kay add auth
kay add mail
```

`kay add` gives an existing project the files and edits `kay new --with` would have written, then runs `bun install`. It reads which features the project has from its files. A feature that needs another is refused with the command that adds both, such as `kay add server,auth`.

Before it writes anything, it checks that each file it changes is still what `kay new` wrote. A file you changed, such as `src/routes/_layout.kay`, stops it with `kay add: nothing was written` and the lines to remove and add by hand. `package.json` gets the scripts and dependencies it lacks, `.gitignore`, `.dockerignore` and `.env` the lines they lack, and an `AGENTS.md` you edited is left alone. A file you deleted is not written back, and the output names it. The CI workflow goes where the `origin` remote says (`.github` for GitHub, `.forgejo` otherwise), and without a remote where the project already has one. A failure after `bun add` puts `package.json` and the lockfile (the monorepo root's too) back.

`mail` and `cms` are the libraries' own features. `kay add mail` adds `@kaynooo/kayjs-mail`, writes `src/mail.ts` and lists `mailExtension` in the `extensions` of `kay.config.ts`, which has to be a plain `defineConfig({ ... })`. `kay add cms` adds `@kaynooo/kayjs-cms`, `@kaynooo/kayjs-ui` and, as a dev dependency, `@iconify-json/tabler`, lists `cms()` there and prints what to set before production.

| Option | Effect |
| --- | --- |
| `--no-install` | Writes the files without running `bun install` |
| `--quiet` | Prints the summary line only |

## kay types

`kay types [dir]` writes `.kay/types`, which the language server, `kay lint` and the editor's ESLint read, and checks nothing. You rarely run it: the editor's ESLint runs it through `bun` the first time it lints a component with no types yet, so a fresh app lints with no command before it.

## kay dev

`kay dev` runs `src/server.ts` with `NODE_ENV=development` in one process for the whole session. An edit to a template, island, loader or API route, to an entry of a content collection, or to a module only those import, the content config and what it imports included (unless a collection has a loader), imports what changed again in that process and swaps the routes in place, which spends about 40% less CPU than a new process per edit. A change it cannot reload that way starts a new process, from cold: the config, the entry, or a module the entry or other code imports, as such a module may hold a connection or a timer. It also starts a new process after 200 reloads, or once the process grew by 64 MiB, because Bun caches the code of the ES modules it evaluates again, up to a cap that this growth reaches first.

An edit also closes what the modules that run again had opened, so it does not pile up: the `process.on` listeners, `setInterval` timers and `Bun.SQL` pools they created, and the `sqliteRooms`, `sqliteCache`, `sqliteRates`, `sqliteJobs` and unnamed SQLite session stores. A resource of a module that did not run again stays open. So does one a library opens for the module, a `bun:sqlite` `Database`: open it in a module that does not run again, or close it in `onStop`.

Open pages refresh by themselves, an edited island is swapped in place, a field you typed into keeps its value through an edit that leaves the field in the page, and a project that fails to compile shows its errors in the browser. What the entry imports before it calls `pages()`, such as a mailer rendering `.kay` mails, imports `.kay` files and icons as pages do.

`kay dev` builds the browser code itself while the server boots, in a process it keeps from one change to the next, and the server reads that build as a production server reads `kay build`'s. An edit builds again only what it reaches: a change to a server module reloads the server alone, a new word in a template builds the Tailwind stylesheets again only when Tailwind makes a class of it, and an edit to stylesheets alone swaps them into the open pages without restarting anything. A `pages()` given options for the browser build that `kay.config.ts` does not hold bundles its own as it boots, and says so: keep those options in `kay.config.ts`.

| Option | Effect |
| --- | --- |
| `--verify` | With `--compile`, starts the executable, waits for its health route and runs `--health`, failing the build with the server's output, see [Prove the executable starts](/guides/deployment#prove-the-executable-starts) |
| `--entry <file>` | The server entry, when it is not `src/server.ts` |
| `--port <port>` | Sets `PORT` for the server, over the shell's and the `.env`'s |
| `--host[=<address>]` | Listens past this machine: `0.0.0.0` alone, or the address given, and answers to this machine's own name and `<name>.local` too. Without it, a server naming no `hostname` listens on `localhost` only, so `kay dev` in a container publishing its port needs `--host` |
| `--inspect[=<address>]` | Opens Bun's debugger in the server, at `ws://localhost:6499/kay` or the port, host and port, or address given, port 0 taking a free one, the same address after every restart: `kay dev` listens there and passes each connection on to the server running, and a debugger's connection stays open across a reload and closes when the server restarts in a new process, for it to connect again; an address another process holds, at `localhost` on either loopback address, stops `kay dev`, and one past this machine needs `--host` too, as whoever reaches the debugger runs code on the machine. A page reaches it only from the dev server's own `localhost` address or `debug.bun.sh` |
| `--open` | Opens the address in the browser (the command `BROWSER` names, else the system's) once the server is ready |
| `--quiet` | Leaves out the line per restart and stylesheet swap, and the keys under the address: the ready line, the addresses, a restart that moved the address and the errors stay. Under `--format json`, it leaves out the same `restart` and `styles` events |
| `--format text\|json` | `json` prints each line below as one JSON object on stdout, `{ "event": "ready", "time": "...", "url": "http://localhost:3000", "ms": 412 }`, with `network` under `--host`, then `restart` (with `"reloaded": true` when the running process took the change in), `styles`, `exit`, `debugger`, `no-browser`, `builder-exit` and an `error` event for each error the server meets, the server's own output going to stderr |

When another process holds the port, the server moves to the next free one, and the ready line names the port it found in use: `kay dev: http://localhost:3001 (ready in 412 ms, 3000 was in use)`. It works however the server picks its port, and restarts keep the port it moved to, so open pages stay connected.

The dev server answers 421 to a request whose `Host` is not `localhost`, a `*.localhost` name, an IP address or the site's host, so a page of another site that renames itself to this machine (DNS rebinding) cannot read it. Any other name the server is reached by, such as a tunnel's, goes in `KAY_DEV_HOSTS`, comma-separated and without ports: `KAY_DEV_HOSTS=dev.example.com bunx kay dev --host`.

A project with no server entry, such as a static site, gets a server of kay's own on `PORT` (3000 by default) and `HOST` (every address by default). So does `kay build --compile`. `kay dev` leaves `HOST` out of the app's environment and listens on localhost, or on the network with `--host`.

The terminal shows the address once, then one line per change, naming what changed and how long it took: `reloaded` when the running process took it in, `restarted` when a new process had to start, or how long a stylesheet edit took to reach the server, with `, now on <address>` when the address changed, and says so when the server exits on its own:

```
kay dev: http://localhost:3000 (ready in 412 ms)
14:02:31 src/routes/index.kay: reloaded in 58 ms
14:02:40 src/server.ts: restarted in 412 ms
14:02:47 src/app.css: stylesheets swapped in 24 ms
14:03:05 the server exited with code 1, waiting for a change
```

On a terminal, a line the same as the one before it is rewritten with a count instead of printed again, as `14:02:31 src/routes/index.kay: reloaded in 58 ms (x3)`. Anything printed between, by the app included, starts a new line, though output the app writes natively, not through `console` or `process.stdout` and `process.stderr`, goes unseen. Piped, every line stays.

Under `--host` with no address, or one listening on every address, a second line names the address other devices on the network reach the server at: `kay dev: http://192.168.1.20:3000 on the network`. It shows when the output is piped too. The address is that of the first interface no container, bridge or VPN made.

In a terminal, the line under the address lists the keys `kay dev` reads: `o` opens the address in the browser, `r` restarts the server in a new process, `c` clears the screen and `q` or Ctrl+C quits. Ctrl+Z does not suspend `kay dev`, as it reads that key too: quit with `q` and start it again instead. Piped, as in CI or under a coding agent, or with `--format json`, it reads no key and prints no such line.

An entry's own `Listening on http://localhost:3000` line is left out; kay's own start line only shows in production.

A project that fails to compile prints its errors there once, as the server boots, formatted as `kay check` prints them, and a request that throws prints its error with its stack mapped to `.kay` lines.

### Errors without a browser

`.kay/dev/errors.json` lists the errors the dev server met, for a reader that never opens the browser, such as a coding agent running `kay dev` in the background:

```json
{
  "errors": [
    {
      "kind": "request",
      "time": "2026-10-14T14:02:31.000Z",
      "request": { "method": "GET", "path": "/blog" },
      "message": "posts is not iterable",
      "report": "TypeError: posts is not iterable\n    at load (/app/src/routes/blog.kay:12:5)",
      "at": { "file": "src/routes/blog.kay", "line": 12, "column": 5, "frame": "11 | ul\n12 |   for post of posts\n   |     ^" }
    }
  ]
}
```

- `kind` is `compile` when the project failed to compile, with each problem's position in `problems` and the report `kay check` prints in `report`; `boot` when the server failed to start otherwise; `request` for a request that threw; `browser` for an error an island met, under its page's path, `island` naming its component and `report` holding the stack as the browser sent it.
- A boot failure goes once a server boots, a request's error once that method and path are answered without one, and a browser error once its page is served again.
- Requests' errors stay across restarts, the latest 50 kept. A server not run by `kay dev` writes none, nor does an entry that throws before it calls `pages()`.

### Dev tool

Every page a dev server serves carries a bar at the bottom left, `kay` and a count of the page's problems, red when one is an error. A click on it, or Alt+Shift+K, opens its drawer; Escape closes it.

- **Problems** lists, each under its heading:
  - errors nothing caught, those kay caught in an island or an effect, and unhandled rejections, with their stack;
  - what kay recovered from in the browser, such as an island that did not match its server markup;
  - what the Content-Security-Policy blocked, naming the directive and the source;
  - what axe-core finds on the rendered page, text the colour of its background counted as low contrast; hovering one outlines the elements it names;
  - what `kay check` reports of the project without type checking.

  A problem logged again shows once with how many times it came. Under `kay dev`, a `.kay` file a problem names opens in the editor on a click. Dismiss, or Dismiss all, hides a problem for the rest of the browser tab, until its text changes; those the page logged go when it is left.
- **Request** shows what served the page: the route it matched, the page and its layouts, the params, the locale, the status with the error a special page shows, and how long each load took, as the `Server-Timing` header has it. It also says whether `kay build` prerenders the page, which guards ran and what each did (passed, redirected, denied, or did not run because an earlier one refused), the redirects the request went through before the page and what made them (a guard, a `redirects` entry, the trailing slash or the visitor's locale), the time the server took to answer, loads, guards and render included, and the response headers with the content security policy and `cache-control` first, a cookie's value left out. All of it is what kay did on that request. A page swap shows the next page's.
- **Head** shows the head of the page in view: the search result it makes, its title and description with their length and the description's limit of 160 characters, the canonical link, hreflang alternates and robots tag, whether the sitemap lists the page, its og and twitter tags with a preview of the social card image, and each JSON-LD block parsed or with its parse error. What `kay check` would flag in the head of a built page, such as a missing or long description, shows as a problem, counted on the tab, and with `seo` set but no `site` it says the page has no canonical link or sitemap. It reads the head again after each page swap.
- **Routes** lists every page, endpoint and API route the server serves, each locale's copy of a page on its own line, with a filter by path or file. A path no request fills in links to itself, the page shown is marked, and the list is fetched again after each restart. A "Served by kay" section lists what kay serves itself: the sitemap, robots.txt, feeds, manifest, favicons, service worker, health check and the dev pages of a library such as kayjs-mail's `/_kay/mail`, each GET path linked. It lists only what the running server serves, so a path one of your files took over shows as yours, and with `seo` set but no `site` it says why there is no sitemap or robots.txt.
- **Env** lists each variable `publicEnv` sends the browser, read from `/_kay/env.js` as a visitor receives it, with its value. One whose name looks like a secret (secret, password, token, a database URL) or whose value does (a URL with a password, a well-known token prefix, a hexadecimal or random string) is flagged, and the tab's count is the number flagged once the tab has been opened; a name ending in `_KEY` only gets a note, as a map or analytics key is public by design. An app with no `publicEnv` is told it sends none. Only what the browser receives is shown, never the server's own env.
- **Images** lists each image of the page: the variant of kay's it got (a width of the ladder, a crop, the share card, or an image kay did not resize), the format and size the server answers it with, and the size it was served at against the size it is drawn at, flagging one served at more than four times the pixels it shows. It marks the largest contentful paint, flags an image with no `width` and `height` or lazy-loaded while in view, and hovering or focusing a row outlines the image on the page. The format is the one the server picks for a browser accepting AVIF and WebP, read with a HEAD request (three seconds at most, four at a time, a failed answer asked again) only for a loaded image served by kay's image route or the files `kay build` wrote; any other image could run a handler of the app, so it shows the size the browser downloaded and no format. The list is read again as the tab shows and as images are added, change or load, and the tab's count, the number of problems flagged, shows once it has been opened.
- **Performance** shows the Web Vitals of the page load, as the browser reports them while the page is used: LCP with the element it painted, CLS and INP (the interactions since the tool loaded, the tool's own clicks left out), each against its good limit (2.5 s, 0.1 and 200 ms) and rated good, needs improvement or poor. They belong to the load, not to the pages a link then swaps in: the tab names the page they were measured on, and says so once a link swapped in another. It also shows the weight of the page, measured again after a swap: the HTML (the document the browser holds, the dev tool left out, gzipped without asking the server for the page again), the CSS it links and the JS it loaded, gzipped, with the entry, the chunks of the islands on the page and the other chunks (kay's lazy runtime) listed apart, file by file. These are dev sizes: nothing is minified and the dev-only code is in, so `kay build` makes them smaller. Under them, "Last kay build" gives the scripts and stylesheets the last build (server build or static export, the newest) measured for the page's route, read from the report kept under `.kay` and not built again, with how long ago it was made; a `~` marks an estimate, as no page of the route was prerendered, and nothing shows before a first build. Its count is the number of vitals not good, shown without opening the tab.
- **i18n** shows for a site with `i18n` and more than one locale. It gives the locale of the page, a link to the same page in each locale, and the message keys the page asked for that no locale has. The count is the number of missing keys, and they clear when a link swaps in another page.
- A library can add a tab of its own, with nothing to declare in the app. **Auth** (kayjs-auth) shows who is signed in, with a sign-out. **Mail** (kayjs-mail) lists the mails sent to the outbox, each previewed in place or opened on its page. **CMS** (kayjs-cms) says whether you are in edit mode and toggles it for the page you are on. These tabs read a route of the library that exists under `kay dev` only. [Writing a tab for a library](/llms/components#a-tab-for-a-library)
- Under `kay dev`, a file either tab names opens in the editor on a click.
- Under `kay dev`, the bar says for a few seconds after each reload, restart or stylesheet swap what changed and how long it took, as `src/routes/index.kay: reloaded in 58 ms`. A page the change reloaded says it too. It never takes the focus. An edit that does not compile reloads the open pages into the [error page](#error-page) instead.
- The drawer follows the system's light or dark theme and docks left or right. Its tabs sit in a rail down its side, Up, Down, Home and End move between them, and a button in its header fills the window. Its open tab, side and size stay for the browser tab, across page swaps and reloads. The Request tab shows a response's Content-Security-Policy with one directive to a line.

Production pages never carry it.

### Error page

A page that throws, when the app has no `_error.kay`, and a server that failed to boot show an error page in development, in the system's light or dark theme:

- the message, and the lines around where the app's own code threw;
- the app's stack frames, those of kay and the dependencies folded under one toggle;
- a Copy button, for the message and the stack as the terminal shows them;
- a compile error as `kay check` prints it.

Under `kay dev`, each frame and compile error position opens in the editor on a click. The page carries the dev tool too, and reloads itself once the error is fixed.

### Inspector

Every page `kay dev` serves knows which `.kay` line wrote each element:

- Hold Alt to outline the element under the pointer with its file, line and column, such as `h1 src/routes/index.kay:12:3`. The outline shows as soon as Alt is pressed, without moving the pointer.
- Alt+click opens that line in the editor. The click never reaches the page, so a link is not followed.
- Inspect, on the dev tool's bar, does what Alt does until the next click or Escape, for a system that keeps Alt+click for itself.
- The Islands tab, counted on the bar, lists each island's component, a click opening its file, with the values its signals hold now. The signals are numbered in the order its script creates them, and hovering a row outlines the island.

The editor is `KAY_EDITOR`, else `VISUAL` or `EDITOR` when they name VS Code, Cursor, Zed, Sublime Text, a JetBrains IDE or code-server, else the first of them on the `PATH`. `KAY_EDITOR` may be any command: it gets the position the way the editor among its words takes it, a terminal editor such as Vim, Neovim or Helix included, or else the file appended:

```sh
KAY_EDITOR=zed bun run dev
KAY_EDITOR="tmux new-window nvim" bun run dev
```

On a Linux machine with no display, as a server reached over SSH while the browser runs on another machine, only code-server can open a window: the file opens in the code-server window already open on the project, else the last one used, unless `KAY_EDITOR` names another command, such as the tmux one above.

With no editor found the page says so, and the terminal prints the position. An editor command that exits with an error within two seconds shows its error in the terminal, and the page says it failed. Tests, `pages({ dev: true })` and production builds carry none of the inspector.

## kay build

```sh
kay build  # into .kay/client
kay build --compile ./server       # one executable
kay build --static --outdir dist   # static files for a host with no server
```

The build runs `kay check` first and keeps the last build when the check or the build fails. It builds for production whatever `NODE_ENV` the shell holds, and needs none of the server's secrets, such as `preview.secret`.

| Option | Effect |
| --- | --- |
| `--compile <file>` | Also bundles the server and everything it serves into one executable |
| `--entry <file>` | The server entry to compile |
| `--static` | Also writes the whole site as static files |
| `--outdir <dir>` | Where `--static` writes, `dist` by default |
| `--no-check` | Skips the check |
| `--analyze` | Lists the modules weighing most in the entry and each island |
| `--deny-warnings` | Fails the build on a warning too, such as `over-budget` |
| `-p <tsconfig>` | Names another tsconfig |
| `--format <format>` | `text` by default; `github` annotates what the check found as `kay check --format github` does, and a template that does not compile or a failed stage too; `json` prints the whole build as one document once it ends, see [Output for tools](#output-for-tools) |

In a terminal, one line on stderr redrawn in place tells what the build is doing and since when, with a bar and a count where it knows how many routes it prerenders or images it encodes (a dynamic route counts once, however many pages it renders). With either output piped, in CI, under `NO_COLOR` or with `--format github` or `json`, it prints only the lines below, as they come.

The build prints the JavaScript a page with islands loads, gzip and minified: the entry, then what each island adds. After it come three more tables:

- **Routes**: one row per route, the heaviest first (25 at most, then a count of the rest), with its pattern, whether the build prerendered it (and how many pages), and the gzip scripts and stylesheets it loads. For a route no page of which was prerendered the scripts are marked `~`: the entry and every island its components can reach, an estimate that follows islands through helpers, dynamic imports and aliases, counts a chunk two islands share once, and adds the entry for a route with no island when a form posts to an action or a server island is deferred. A route whose pages all answered a status other than 200 counts as prerendered.
- **Stages**: the time the check, the bundle (which run side by side), the prerender, the route sizes, the images and cards, the favicons, the page hooks and the compression took.
- **Caches**: for each cache under `.kay/cache` (`components`, `analyses`, `image variants`, `share cards`, `favicons`, `compressed copies`, `package probes`, `runtime chunk`), how many entries came from it and how many were made, as `image variants: 40 cached, 2 made`.

Each size shows its change since the last build, as `[+3.2 KB]`, or `[new]` for a row the last build did not have, and nothing when it did not change. A route, an island or the entry the last build had and this one does not is listed after the routes under `Removed since the last build:`. The sizes of the last successful build are kept in `.kay/report.json`, and a build that fails leaves them as they were; a `--static` export is compared with the last export, and a server build with the last server build. Long paths lose their middle to fit the terminal, and the report has no colour or control code, so a CI log reads the same. `--quiet` leaves the report out.

To keep pages light, set a budget in `kay.config.ts`. Nothing is limited until you do:

```ts
export default defineConfig({ budget: { js: '20kb', css: '10kb' } })
```

Each key is a size in bytes, or a string ending in `b`, `kb` or `mb`, and limits what one page loads, compressed as a host serves it. The build then warns with `over-budget` for each route over it, at the route's file, and lists the three modules weighing most in its scripts. Set the lint to `deny` in `lints` to fail the build on it, or pass `--deny-warnings`, which fails it on any warning, the check's included.

Every build writes `/_kay/THIRD-PARTY-LICENSES.txt`, served beside the rest and copied by `--static`: each package whose code, stylesheets or fonts the browser gets, and every `@iconify-json` set the project depends on, with its licence text. A set whose licence asks for more than that notice, such as CC BY's credit where the icons show, gets a warning. An executable prints the same notices, its server's packages added, for `./server --licenses`, with the licences of the codecs kay's AVIF encoder and decoder compile in (libavif, libaom, libsharpyuv, Emscripten's glue and musl).

## kay start

```sh
kay start              # the last build, as the deployed server runs it
kay start --port 8080
```

It serves the last `kay build` with `NODE_ENV=production`: the executable `--compile` wrote when that build made one (a later build without `--compile` drops it, and a build newer than the executable gets a warning), the server entry otherwise, or kay's own server of the pages in a project without one. It refuses to start without a build, and warns when a source changed since, naming the latest. The env files are read as the server reads them, as Bun does under `NODE_ENV=production`: `.env.production` and `.env` both, so a value only `.env` holds, such as a development database, reaches `kay start` unless `.env.production` sets it too. A variable the shell sets wins over both.

| Option | Effect |
| --- | --- |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |
| `--port <port>` | The port to listen on: `--port`, else the shell's `PORT`, else the one `.env.production` or `.env` sets, else 3000 |

Ctrl-C, `SIGTERM` and `SIGHUP` reach the server once each, whether sent to the terminal's process group or to `kay start` alone, and `kay start` waits for it to drain and exit; a second Ctrl-C stops it at once. `SIGQUIT` is passed on as well, and ends the server at once (131). The server runs in a process group of its own, so Ctrl-Z suspends `kay start` but not the server, and a `SIGKILL` to the whole group, which `kay start` cannot pass on, leaves the server alone: a kay server notices `kay start` is gone within a second and drains as on `SIGTERM`, or stops as soon as it boots when `kay start` died before. `kay start` exits with the server's code, with 0 when the server ended on a stop signal it passed on, and with 128 plus the signal's number when the server died of another, as an out-of-memory kill (137) or a crash (134, 139).

## kay render

```sh
kay render /about                     # the page's HTML on stdout
kay render /account --cookie session=…
kay render /_kay/action/src/routes/index.kay/add --body 'title=Milk' -i
```

It answers one request as the server entry answers it under `NODE_ENV=development`, what it uses included, as `kay dev` serves it but without the inspector's attributes, and prints the body on stdout, so a script or an agent sees what a page renders without starting a server and fetching it. The server runs on a Unix socket of its own rather than a port, so it runs beside a `kay dev` holding the port, and stops once it answered, or starts stopping within a second of `kay render` being killed; it builds the browser code into a directory of its own under `.kay`, removed afterwards, never touching what `kay build` or `kay dev` wrote. A `kay render` killed with SIGKILL cannot clean up, so the next one removes what it left. What the server logs, the error report of a page that throws included, goes to stderr.

The whole app boots for it, as for `kay dev`: its jobs and the top-level code of its modules run, and a `POST` to an action runs the action against the app's database. The request goes to the first server the entry starts. A full URL gives its host to the request, as a site served on several hosts or a locale's domain reads it; it is sent over plain HTTP whatever its scheme. A server that has not listened after 60 seconds fails the command.

A redirect prints `kay render: 302 Found, to /login` on stderr and nothing on stdout, and exits 0. A status of 400 or above prints its line on stderr, the body still on stdout, and exits 1. A server that exits before it serves, as on an error at the entry's top level, fails with its code. Under `base`, a path under it is taken as the proxy in front of the server hands it over, so a link a page printed renders as it is, and so does the same path without it.

| Option | Effect |
| --- | --- |
| `--method <method>` | The request's method, `GET` by default, `POST` with `--body`, which `GET` and `HEAD` refuse |
| `--body <text>` | The request's body, sent as a form posts it, `application/x-www-form-urlencoded`, unless a `--header` names another `content-type` |
| `--header <name: value>` | A request header; repeat it for more |
| `--cookie <name=value>` | A cookie; repeat it for more. A guarded page renders signed in with the session cookie a browser holds, copied from its developer tools |
| `-i`, `--include` | Prints the status line and the response's headers on stderr |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |

## kay check

```sh
kay check --deny-warnings --fix
kay check src/routes/blog src/lib/feed.ts   # only the problems in those
kay check --watch
```

The first path is the project when it is a directory holding a `kay.config.ts`, a `package.json` or a `tsconfig.json`, or any directory outside the current directory, so a directory given first to narrow the report must be neither. The other paths, relative to the current directory, narrow the report, and `--fix`, to the problems in those files and directories, a symlink read as what it points to; a path outside the project fails the check. The project is still type-checked as a whole.

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Fails on warnings too, not only on errors |
| `--watch` | Checks again on every change to the project, tests included, clearing the previous report in a terminal. Each check is a `kay check` of its own, so an edit to `kay.config.ts` counts and a check that cannot run, or exits before reporting, leaves the watch going. An interrupt or a closed terminal stops the check running and what it started, a second interrupt killing them |
| `--fix` | Applies the fixes that change nothing else, then reports what is left |
| `--only <group>` | Reports one group's lints alone, such as `seo`, as an audit |
| `--since <minor>` | Reports, and with `--fix` fixes, the `deprecated` lints that came in that minor alone, as `1.46`. `kay upgrade` runs it once per minor. It does not go with `--only` |
| `--format <format>` | `text` by default; `github` prints each problem as a workflow command, `::error file=src/a.kay,line=4,col=3,title=missing-alt::...`, which GitHub and Forgejo Actions show on the diff, its `file` relative to `GITHUB_WORKSPACE`, the repository's root, when set, else to the current directory; `json` prints them as one document on stdout, `{ errors, warnings, problems }`, each problem with its `file` relative to the current directory, `line`, `column`, `endLine` and `endColumn` past the span, `severity`, `code`, `message`, and `label`, `note`, `help` and `related` when it has them. A check that cannot run, on a path that does not exist or a `kay.config.ts` that does not load, prints one error in the format too, `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`, with the config's `file`, `line` and `column` when it does not parse. The exit code is the same in every format |
| `-p <tsconfig>` | Names another tsconfig, relative to the directory |
| `--entry <file>` | The server entry whose `app` types `ctx.locals`, `src/server.ts` by default |

`kay check` and its lints have their [own page](/reference/checks).

## kay upgrade

```sh
kay upgrade
kay upgrade ../my-site
```

It moves `kay` and every `@kaynooo/kayjs-*` library in `package.json` to the latest version the registry has, then installs. A range pointing at a path, a workspace or a git source is left as it is.

Then it runs the kay it just installed. Each minor between your old version and the new one may have replaced a form with a new one, and each such replacement is a lint in the `deprecated` group with a fix. The fixes of the oldest minor run first, then the next, and so on. A last `kay check --fix` applies any other quick fix and prints what is left for you to change by hand. Its exit code is the check's.

An app already on the latest version is left alone. If the install fails, `package.json` goes back as it was, and you can run `kay upgrade` again once the install works. What a minor breaks that `kay check` cannot see is in [Upgrading](/guides/upgrading).

## kay routes

```sh
kay routes
```

```
GET   /admin/report               page      src/routes/admin/report.kay, prerendered
      layouts src/routes/_layout.kay > src/routes/admin/_layout.kay
      guards  src/routes/admin/_guard.ts
POST  /_kay/action/src/routes/index.kay/add  action  src/routes/index.kay add
GET   /api/items                  api       src/api/items.ts
GET   /old                        redirect  308 to /
GET   /_kay/health                kay       health check
```

It lists the routes the project serves in production, without starting the server or running a page or a guard: each page with its layouts and guards, outermost first, once per locale's path, `/about` and `/fr/a-propos`, with its matchers shown as its file names them, `/items/:id=integer`; each action of a page or a layout; each endpoint; each route of an API module, with its method, `WS` and `OPTIONS` included; the routes of an extension's `server` given as an Elysia instance; each redirect and collection feed; and the routes kay serves itself as the config turns them on, such as `/_kay/health`, the favicons and the sitemap. A page is marked `prerendered` with `prerender: true` or a server island, and `prerendered as its prerender setting lists` with a list or a function. `--format json` gives the routes as one document, every locale's copy with its layouts and guards ([Output for tools](#output-for-tools)). A route that sets `guards: false` is marked `open`, one that `requireGuards` refuses with a 403 says so, and a library's API module shows the guards of its own directory.

API modules are the one thing it runs, as their routes are only known once their Elysia instance is built, so their top-level code runs: what it writes to stdout, through the console or `process.stdout`, goes to stderr, off the listing, and one that fails to load, as without the server's environment, or calls `process.exit()`, is listed by its mount with why. What the server entry adds itself, such as kayjs-auth's `.use(auth.plugin)`, and an extension's `server` given as a function are only built as the server starts: a last line names them as not listed.

## kay migrate

```sh
kay migrate astro . --out ../kay-site
```

Translates an Astro project's `.astro` files into `.kay` ones, its pages into `src/routes` and its content config into kay's, then lists what is left to do by hand at its line in the Astro file. It never writes over a file that exists.

| Option | Effect |
| --- | --- |
| `[dir]` | The Astro project, the current directory by default |
| `--out <dir>` | Writes there instead of next to the `.astro` files. A directory with no `package.json` gets a whole kay project: `package.json`, `kay.config.ts`, `tsconfig.json`, a server entry when the site renders on demand, and the project's other files under `src` and `public` |

`--format json` gives what it wrote and left to do as one document ([Output for tools](#output-for-tools)).

The [Astro guide](/guides/migrating-from-astro) shows what it translates and how to finish what it lists.

## kay mcp

```sh
claude mcp add kay -- bunx kay mcp
```

Serves the project in the current directory to an agent as an [MCP](https://modelcontextprotocol.io) server over stdio, so it calls kay's commands as typed tools instead of running them in a shell. Nothing is set up in the app: the agent's client starts `kay mcp` from the project's root, where kay is installed. Another client takes the same command in its MCP config, such as `.mcp.json` at the project's root for Claude Code (a client may name the key `servers`):

```json
{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }
```

It speaks the revision that opens with `initialize` (`2025-11-25` and earlier) and `2026-07-28`, whose requests carry their version in `_meta`. Stdout holds the protocol alone.

| Tool | Does |
| --- | --- |
| `check` | `kay check --format json`: `{ errors, warnings, problems }`. `paths` narrows the report to files or directories of the project (`.` is all of it, and a directory holding a `package.json` is a path to report on, not a new project), `only` to a group of lints, `denyWarnings` counts warnings as failures. A problem found is a result, not an error |
| `routes` | `kay routes --format json`: every route with its file, layouts and guards |
| `explain` | The lints and error codes, or with `name` a lint, an error code or a group, as `kay explain --format json` |
| `render` | `kay render` on `url`, with `method`, `body`, `headers` and `cookies`: the body, then the status line, headers and server log. A body that is not text comes back as an image or a blob, unchanged. A status of 400 or above is an error result that keeps the body |
| `dev_errors` | The errors a running `kay dev` met, read from `.kay/dev/errors.json` ([Errors without a browser](#errors-without-a-browser)); empty when it has met none |

The resources are `kay://llms.txt`, the index to start from, and one `kay://llms/<file>.md` for each guide of kay's `llms/`, described by its title and the headings of its sections.

Each tool runs its command in a child process, so a call costs what the command does: a `check` takes as long as `kay check`. Calls run one at a time, in the order they came, as they share the project's `.kay` and a `render` boots the whole app; a call waits for the one before it. A command that is stopped, by a timeout or by the client leaving, takes what it started along, its server or its type checker. `kay mcp` keeps no project loaded between calls, as `kay lsp` does.

## Other commands

```sh
kay explain positional-key   # one lint, with an example and the fix
kay fmt src                  # format a folder
kay fmt --check              # list unformatted files and fail
kay explain --format json    # every lint, for a tool to read
kay lint --fix --cache       # ESLint, with the types it reads written first
```

`kay lint` writes the types ESLint reads for `.kay` files, then runs the project's `keslint` with the arguments you give it. The `lint` script of a new project is `kay lint --cache`.

`kay explain` and `kay fmt` take `--format json` too ([Output for tools](#output-for-tools)).

## Quiet and plain output

`kay build`, `kay check`, `kay dev`, `kay fmt`, `kay migrate` and `kay new` take `--quiet`: they print the problems and one summary line, without the size report, the files one by one or the next step to run. `kay build` keeps one line per step it ran, `--static` and `--compile` adding theirs, and `kay fmt --check` names the unformatted files alone. `kay dev --quiet` prints its ready line and the errors, no line per restart or stylesheet swap. Every other command refuses it.

```sh
kay fmt src --quiet   # formatted 3 files
```

Colour only goes to a terminal, and not under `NO_COLOR` or `TERM=dumb`; `FORCE_COLOR` brings it back to a pipe, as a CI log showing colour wants. The build's progress line and `kay check --watch`'s cleared screen only ever go to a terminal, `FORCE_COLOR` or not.

## Output for tools

`kay build`, `kay routes`, `kay explain`, `kay fmt` and `kay migrate` take `--format json`, as `kay check` does, for a script or an agent to read: stdout then holds one JSON document on one line, what the app's own code prints through the console or `process.stdout`, such as `kay.config.ts`, an API module or a prerendered page, going to stderr; a write straight to the file descriptor, as `Bun.write(Bun.stdout, ...)`, still lands on stdout. The exit code is the one the text output gives.

| Command | Document |
| --- | --- |
| `kay build` | `{ errors, warnings, problems }` as `kay check` prints them, a template that does not compile at its place and any other failure as one problem with `code: null`; `failed: { stage }` when a stage stopped it (`check`, `bundle`, `output`, `export` or `compile`); `built: { islands, stylesheets, prerendered, entries, ms, sizes, routes, stages, caches }`, `sizes` holding the entry's and each island's `raw` and `gzip` bytes, with their heaviest `modules` under `--analyze`, the `why` of each island and `promoted` for a static component that only may be one, `routes` each route's `js` and `css` gzip bytes with the `islands` its pages render, or its components can reach when it is an `estimated` reach, and its `pages` prerendered, the `kept` pages the build kept on its own and, for a route rendered per request, the `stop` that decided it and whether its scripts are an `estimated` reach, `stages` the `ms` of each stage and `caches` how many entries each cache gave (`cached`) and had made (`made`); `exported: { pages, files, dir, ms }` with `--static`; `compiled: { executable, ms, verifiedMs }` with `--compile`, `verifiedMs` with `--verify` |
| `kay routes` | `{ routes, unlisted }`, each route with its `methods`, `path`, `kind`, `by` as the listing shows it, and `file`, `notes`, `layouts` and `guards` when it has them |
| `kay explain` | `{ groups, lints, errorGroups, errors }`, each lint's `name`, `group`, `level` and whole `summary`; for one lint, its `name`, `level`, `group`, `summary`, the `wrong` and `right` examples, and `typed`, `site` and `launch` when set; for an error, its `name`, `group`, `summary` and `fix`, the file and heading that cover it |
| `kay fmt` | `{ errors, warnings, problems, written, changed }`: what does not parse as problems, and the files it formatted, or under `--check` would, `written` false |
| `kay migrate` | `{ written, kept, copied, notes }`: the files written and those kept as they exist, how many other files it copied, and each item left to do by hand with its `file`, `line`, `target` and `message` |

Code a build runs that ends the process, such as a prerendered page calling `process.exit()`, leaves the problems found so far and one saying it ended, with the stage it ended in. The build exits with code 1 then, even when that code exits with 0, as it never finished. A command that cannot run, on a directory that does not exist, options that do not go together, a `kay.config.ts` that does not load or a lint that is none, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`. Paths are relative to the current directory.

<ReadMore href="/llms/project">Every `kay new` feature, what `kay dev` restarts on, the compiled executable's limits and what `kay migrate` translates are in the full project reference.</ReadMore>
