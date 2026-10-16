<img src="src/server/favicon.svg" alt="kay's kingfisher" width="96" height="96">

# kay

A Bun web framework. A `.kay` file is one component: TypeScript fences, then a pug-like indented template. Pages render to plain HTML strings on the server, islands run on kay's own signals and DOM runtime, and an Elysia plugin serves it all, with typed form actions and type checking down to the `.kay` line.

The full reference, written for people and coding agents alike, starts at [llms.txt](llms.txt): the rules most often got wrong, then one line per topic linking its doc in [llms/](llms). The site at [kayjs.kaynooo.fr](https://kayjs.kaynooo.fr) is the documentation written for people, short pages each opening on an example, with this reference beside it under `/llms`; it is built with kay itself by `bun run docs:build` into `docs/dist`, its pages in `docs/src/content`; the tutorial's app is [examples/reading-list](examples/reading-list), and [examples/noticeboard](examples/noticeboard) runs kay with kayjs-auth, kayjs-mail, kayjs-ui and Postgres together.

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

## Ship it

```sh
bun run check   # kay check: types, templates included
bun run test    # bun test, pages and actions served in-process by kay/test
bun run build   # kay build: kay check beside the browser bundle, then prerendered pages, all into .kay/client
bun run start   # kay start: the last build, served as in production
```

In production the server serves what `kay build` wrote and bundles nothing at boot. `kay build --compile server` goes one step further and writes `server`, one executable holding the server, its pages and the client build, which needs neither Bun nor the project installed where it runs.

## Commands

| Command | Does |
| --- | --- |
| `kay new <dir> [--template blank\|server\|site\|app] [--with <features>] [--without <features>] [-y] [--kay <dependency>]` | scaffold a project that checks, builds and runs: one bare page, a server run as one executable, a static site, or an app with sessions and members in Postgres through pg-orm; in a terminal with none of these options it asks for a preset, then for each feature; `--with` and `--without` change the preset's features, `-y` takes the server preset without asking, `--kay` sets its `kay` dependency |
| `kay dev [dir] [--entry <file>] [--port <port>] [--host[=<address>]] [--inspect[=<address>]] [--open] [--format text\|json]` | run the server, restarting on change, errors shown in the browser |
| `kay build [dir] [-p tsconfig.json] [--no-check] [--analyze]` | bundle the browser code for production while checking the project as `kay check` does, keeping the last build when either fails; `--no-check` skips the check |
| `kay build [dir] --compile <file> [--entry <file>]` | the same, plus the server and everything it serves in one executable, `--entry` naming the server entry |
| `kay build [dir] --static [--outdir dist]` | the same, then the whole site as static files for a host with no server |
| `kay check [dir] [paths...] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>] [--format text\|github\|json] [--watch]` | type-check the project, `.kay` files included, `-p` naming another tsconfig and `--entry` the server entry whose `app` types `ctx.locals`; warnings fail it only with `--deny-warnings`, which a scaffolded app leaves out, and `--fix` applies the fixes that change nothing else first |
| `kay start [dir] [--entry <file>] [--port <port>]` | serve the last build as production does |
| `kay render <url> [dir] [--method <method>] [--body <text>] [--header <name: value>] [--cookie <name=value>] [-i] [--entry <file>]` | print what the server answers for one URL, as `kay dev` serves it, without starting it on a port |
| `kay routes [dir]` | list every route the project serves, and the file serving it |
| `kay explain [lint\|error\|group]` | list the lints and the errors, or a group's, or explain one: a lint with an example it reports and the same written right, an error with where its fix is written |
| `kay fmt [paths...] [--check]` | format `.kay` files |
| `kay lint [keslint arguments]...` | write the types the lint of `.kay` files reads, then run the project's `keslint` on the arguments, with no `kay check` needed first |
| `kay migrate astro [dir] [--out <dir>]` | translate an Astro project into `.kay` files, listing what is left by hand |
| `kay lsp --stdio` | language server for the editor extension in `editors/vscode` |

## Upgrading

A minor release may break an app. [Upgrading](llms/upgrading.md) lists what each one breaks and what to change.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks and what a pull request needs. Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, and follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). [NOTICE](NOTICE) lists the third-party code kay carries and its licenses.
