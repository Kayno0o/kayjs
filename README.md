<img src="src/server/favicon.svg" alt="kay's kingfisher" width="96" height="96">

# kay

A Bun web framework. A `.kay` file is one component: TypeScript fences, then a pug-like indented template. Pages render to plain HTML strings on the server, islands run on kay's own signals and DOM runtime, and an Elysia plugin serves it all, with typed form actions and type checking down to the `.kay` line.

The full reference, written for people and coding agents alike, starts at [llms.txt](llms.txt): the rules most often got wrong, then one line per topic linking its doc in [llms/](llms). The site at [kayjs.kaynooo.fr](https://kayjs.kaynooo.fr) is the documentation written for people, short pages each opening on an example, with this reference beside it under `/llms`; it is built with kay itself by `bun run docs:build`, served by `bun run docs:start`, its pages in `docs/src/content`; the tutorial's app is [examples/reading-list](examples/reading-list), and [examples/noticeboard](examples/noticeboard) runs kay with kayjs-auth, kayjs-mail, kayjs-ui and Postgres together.

## Start a project

kay is published as `@kaynooo/kayjs` to the Forgejo registry at git.kaynooo.fr. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml`, or `$XDG_CONFIG_HOME/.bunfig.toml` when that variable is set, as Bun then reads only that one:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun install
bun run dev   # http://localhost:3000, reloads on every change
```

The project depends on it as `"kay": "npm:@kaynooo/kayjs@~<version>"`, a tilde since a minor may break, so imports read `kay`, `kay/server` and so on, and carries an `.npmrc` pointing the scope at the registry. `bun src/cli.ts new ../my-app` from a checkout of this repository depends on a packed copy of it instead.

## A page and an island

A page is a `.kay` file under `src/routes`, and a component with state is an island that runs in the browser, hydrated where the page uses it.

`src/counter.kay`:

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

`src/routes/index.kay`:

```kay
---
import Counter from '../counter.kay'
---
head
  title Home
h1 Hello
Counter
```

## Ship it

```sh
bun run check   # kay check: types, templates included
bun run test    # bun test, pages and actions served in-process by kay/test
bun run build   # kay build: kay check beside the browser bundle, then prerendered pages, all into .kay/client
bun run start   # kay start: the last build, served as in production
```

In production the server serves what `kay build` wrote and bundles nothing at boot. `kay build --compile server` goes one step further and writes `server`, one executable holding the server, its pages and the client build, which needs neither Bun nor the project installed where it runs.

## Commands

Every command takes an optional project directory and prints its usage for `--help`; [the CLI page](https://kayjs.kaynooo.fr/reference/cli) lists each one's options.

| Command | Does |
| --- | --- |
| `kay new` | scaffold a project: one bare page, a server run as one executable, a static site, or an app with sign-in |
| `kay add` | add `kay new` features, or a kay library, to an existing project |
| `kay generate` | write a starter page, component, island, action, API module or guard, with a test |
| `kay dev` | run the server, restarting on change, with errors shown in the browser |
| `kay build` | check the project and bundle the browser code for production, as a server, one executable or static files |
| `kay start` | serve the last build as production does |
| `kay render` | print what the server answers for one URL, without starting it on a port |
| `kay screenshot` | shoot a page of the running `kay dev` in a headless Chrome |
| `kay a11y` | check every page of the site with axe-core and draft its accessibility statement |
| `kay check` | type-check the project, `.kay` files included |
| `kay upgrade` | move kay and its libraries to the latest version and rewrite the old forms |
| `kay routes` | list every route the project serves, and the file serving it |
| `kay not-found` | list the old URLs visitors hit and found nothing at, and turn one into a redirect |
| `kay env` | list the environment variables the project, its libraries and kay declare |
| `kay doctor` | check Bun, versions, config, environment, port and build, and say how to fix each failure |
| `kay explain` | list the lints and the errors, or explain one |
| `kay docs` | print the section of kay's or an installed library's docs that words or a name match |
| `kay types` | write the types the editor's ESLint reads for `.kay` files, without checking |
| `kay fmt` | format `.kay` files |
| `kay lint` | run the project's ESLint with the types it reads for `.kay` files |
| `kay test` | run `bun test` with each file isolated and kay's preload loaded |
| `kay i18n missing` | list what each locale lacks against the default one |
| `kay i18n accept` | accept a locale's draft messages |
| `kay migrate` | translate an Astro project into `.kay` files, or rewrite the entry files that `migrations` carry over |
| `kay lsp` | the language server behind the editor extension in `editors/vscode` |
| `kay mcp` | serve the project to an agent as MCP tools and resources |

## Upgrading

[What's new](llms/whats-new.md) lists what each release adds, and a minor release may break an app: [Upgrading](llms/upgrading.md) lists what each one breaks and what to change.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks and what a pull request needs. Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, and follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). [NOTICE](NOTICE) lists the third-party code kay carries and its licenses.
