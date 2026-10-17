# Building and starting

## Common tasks

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

A server entry from `kay new` and kay's own server listen on `PORT`, 3000 by default, and on `HOST` when it is set (`HOST=127.0.0.1 ./server`), every address otherwise; `kay dev` ignores `HOST` and listens on localhost, or what `--host` opens, unless the app names a `hostname` itself.

A project with no `src/server.ts` and no `--entry` runs kay's own server of its pages on `PORT` and `HOST`, as `kay dev`, `kay start` and `kay render` do, so an app with nothing custom on its server writes no entry: it adds one to mount a plugin, a job or an `onStop` hook.

### Export a static site

`--static` writes the whole site to a directory for a host with no server:

```sh
kay build --static --outdir dist
```

## Reference

### Build and start commands

- `kay build [dir] [-p tsconfig.json] [--no-check] [--analyze] [--deny-warnings] [--format text|github|json] [--quiet]`:
  - Bundle the islands and stylesheets for production, whatever `NODE_ENV` the shell holds and with none of the server's secrets, such as `preview.secret`, needed, minified, into `.kay/client` while checking the project as `kay check` does, `-p` naming the tsconfig as there;
  - Once the check passed, render the pages marked `prerender`, so no page, API module or guard runs before then.
  - With the check on, a problem it reports, check-only ones included, or a build that fails leaves the last build in `.kay/client` as it was; `--no-check` skips the check and builds in place.
  - Then start the server with `NODE_ENV=production`, as `kay start` does.
  - Each page preloads the chunks of the islands it renders. kay's runtime that the entry and at least half of the app's islands use is the one chunk a page loads first, so a page with islands loads that chunk and one per island, plus one for code several islands import. A runtime module fewer islands use, such as the action runtime behind `ActionError` or the image variants behind `img(src={...})`, is loaded with those islands only, so a text page of an app with many islands loads about what a small app's does. An island's markup names its chunk's file (`data-chunk`), which the browser imports from beside the runtime under any `base`, so the entry holds no loader for the app's other islands and a page's scripts grow with its own islands only; `kay dev` keeps a registry in its entry instead, to swap an edited island in.
  - In a terminal, one line on stderr redrawn in place names the step running, its time, and a bar with a count for the routes it prerenders and the images it encodes, cleared before anything else prints and on Ctrl-C; with stdout or stderr piped, under `NO_COLOR`, on a `TERM=dumb` terminal or with `--format github|json`, no such line and no control code.
  - The build prints what that weighs, gzip then minified: the entry every page with an island loads, then what each island adds beyond it, the heaviest first; `--analyze` also names the five modules weighing most in each, a package's files counted as one, kay's runtime file by file.
  - `budget: { js: '20kb', css: '10kb' }` in kay.config.ts (bytes or a string with `b`, `kb` or `mb`; both keys optional, no default) limits what one page loads, compressed: the build warns with `over-budget` for each route over it, at the route's file, naming the three modules weighing most in its scripts (it measures them for that even without `--analyze`, which only prints them). The lint is a warning that `lints` can set to `deny`; `--deny-warnings` fails the build on any warning of the check or a lint (not the icon-set and codec notes); a limit that is no positive size (decimals fine, zero, negatives and exponents refused) is reported by `kay check` and fails the build.
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
  - The same, then writes the whole site to `--outdir` for a host with no server; see [Static export](prerendering.md#static-export).
- `kay start [dir] [--entry <file>] [--port <port>]`:
  - Serve the last `kay build` as the deployed server would, with `NODE_ENV=production`: the executable `--compile` wrote when that build made one (a later build without `--compile` drops it; one older than the build warns), else the server entry, else, in a project with none, kay's own server of its pages.
  - It refuses without a build in `.kay/client`, and warns when a file the server or its build reads changed since, naming the latest; env files are left for the server to read as Bun does under `NODE_ENV=production`, `.env.production` and `.env` both, so a value only `.env` holds reaches it, the shell's variables winning.
  - `--entry` runs another entry, relative to the current directory; `--port` sets `PORT`, over the shell's and the env files', 3000 otherwise.
  - Ctrl-C, `SIGTERM` and `SIGHUP` reach the server once, sent to the group or to `kay start` alone, which waits for it to drain, a second Ctrl-C stopping it at once; `SIGQUIT` is passed on and ends it at once (131).
  - The server runs in a process group of its own: Ctrl-Z suspends `kay start` alone, and once `kay start` is gone, as after a `SIGKILL` to the group, a kay server notices within a second and drains as on `SIGTERM`, or stops once booted when it was gone already;
  - It exits with the server's code, 0 when the server ended on a stop signal it passed on, 128 plus the signal's number when it died of another.
  - The `start` script `kay new` writes runs it.
