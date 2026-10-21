# Environment variables

Reading the environment typed, and letting an island read a variable. Sessions, locals and guards are in [Locals, sessions and guards](server.md).

## Common tasks

### Read the environment, typed

`defineEnv` reads `process.env` once against a schema, as the server boots, and a missing or refused variable stops the boot:

```ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
  DEBUG: s.Optional(s.Boolean()),
}))
```

`defineEnv(schema, source)` reads `source` instead of `process.env`, for a module building its own env. A test gives a variable of `env` another value with `overrideEnv` from `kay/test` ([Testing](testing.md)).

### Let an island read a variable

`publicEnv` in kay.config.ts declares the variables an island may read, such as a map key or an analytics id:

```ts
import { s } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: s.Object({
    MAP_KEY: s.String(),
    ANALYTICS_ID: s.Optional(s.String()),
  }),
})
```

A component reads it as `publicEnv` from `kay`, typed from the declaration:

```kay
---
import { publicEnv } from 'kay'
---
button(onClick={() => console.log(publicEnv.MAP_KEY)}) Log the map key
```

## Reference

### Environment

- `defineEnv` from `kay/server` reads `process.env` once against a schema, as the server boots, and gives it back typed.
- A number or boolean is read from its text as a form field is, a variable left out takes its `default`, and any missing or refused stops the boot with an error naming each one.
- An empty variable, `SMTP_PORT=` or `SMTP_PORT=""` in a `.env` file, counts as left out: it takes the default, satisfies `s.Optional` and fails a required one, rather than an empty string reaching the schema.
- So an empty string is not a value a variable can carry: a setting that means something when blank is `s.Optional`, read as `undefined`.
- A value of spaces is kept as it is, since only quoting makes one.
- `kay build` runs without the server's environment: there a missing or refused variable leaves the module declaring it alone, and reading it throws naming it, which fails only a prerendered page that reads it.
- The object holds the declared names only.
- `requiredInProduction: true` on a field makes it required under `NODE_ENV=production` only: there it is refused at boot when missing, its `default` dropped and `s.Optional` no longer applying; in development and tests it takes its `default`, stays `undefined` under `s.Optional`, or is `''` when a `s.String` has neither, so `DISCORD_CLIENT_ID: s.String({ requiredInProduction: true })` types as `string` and needs no placeholder in the app and no second list of production keys; `s.Optional(s.String({ requiredInProduction: true }))` keeps `string | undefined`.
- `s.Secret()` is a string of at least 32 characters required in production, which development and tests read as a derived value, so sessions survive a restart and nothing is committed: `SESSION_SECRET: s.Secret()`; a value set in the environment wins, and `kay env` lists it as a secret required in production (`secret: true` in JSON). `kay new` uses it. Only under `NODE_ENV` `development` or `test` (`kay dev` and `bun test` set them) is it derived, from the path, the name and a random seed kept in `.kay/dev-secret` (git-ignored, 0600, written on first use and again when empty or cut short, read once per process); under any other `NODE_ENV`, or none, a missing one refuses the boot as a plain `s.String({ minLength: 32 })` does, and a `.kay` that cannot be written is an error naming it.
- `NODE_ENV=production kay build` counts as production too: a prerendered page reading a flagged variable needs it set for the build, or reads it where the server runs.
- `kay env [dir] [--compose <file>]... [--example <file>] [--format text|json]` lists every variable the project declares, without its environment and without running the server entry, whose own `defineEnv` calls it leaves out: the `defineEnv` schemas in the modules under `src` (imported, so their top-level code runs), `publicEnv`, the `env` schema of each extension in kay.config.ts (a library's, such as kayjs-mail's SMTP variables or kayjs-ai's provider keys and `AI_MODEL`, with no wiring), and kay's own `PORT`, `HOST`, `SITE_URL`, `ORIGIN` and `KAY_SECRET`. A schema built inside a function is not seen. A library's mailer built in one of those modules, such as `mailer()` from kayjs-mail, is listed once under that module, as its options set it up. Each has its `name`, `source`, `type`, `required` (`'always'`, `'production'` or `false`), its `default` and `description` when it has them; a module that fails to load is under `unread`.
- `env: { compose: 'compose.prod.yaml', example: '.env.example' }` in kay.config.ts (`compose` takes several files), or `kay env --compose <file>... --example <file>`, compares what the project declares with those files, and `kay check` runs it with no flag: a variable production needs (`required` not `false`) that no compose service sets, in `environment` (a map or a list, `${VAR:-x}` included) or an `env_file`, is an error; so is one the example does not list unless a compose service gives it a literal, and one the example lists that no schema declares, no service sets and no `${VAR}` of the compose file reads (`POSTGRES_PASSWORD`). A `process.env.X` or `Bun.env.X` read in `src` outside tests (`NODE_ENV` apart) that nothing declares is a warning, which `kay check --fix` can declare for you ([Check](check-and-tools.md)). `kay env` prints the findings and exits 1 on an error; `--format json` adds `findings`, as `kay check` prints its problems. A file named and missing, or a compose file that is not YAML, is an error; leave a key out to skip its half. `--compose` and `--example` resolve against the project root and, when given, replace the config's `env` wholesale. A module under `src` that does not load is an error and stops nothing being judged undeclared; an empty value (`FOO=`, `FOO: ''`) counts as unset, as `defineEnv` reads it. Raw reads are found in one-line `process.env.X`, `process.env['X']`, `Bun.env.X` and `const { X } = process.env`, not in a multi-line destructuring, a computed name or `import.meta.env`.
- Server code imports it: a `.ts` module, a server fence, the server entry; an island never sees the server's environment.
- `publicEnv` in kay.config.ts declares the variables an island may read, such as a map key or an analytics id, which a component reads as `publicEnv` from `kay`, typed from the declaration.
- They are read from the environment as the server boots, as `defineEnv` reads its own, a missing or refused one stopping it.
- The browser gets them from `/_kay/env.js`, which the server answers from its environment and the island entry imports before any island hydrates, so an executable, or a page prerendered at build time, carries the values of the environment it runs in; `kay build --static` writes that file with the build's.
- The markup a prerendered page rendered holds the build's values, though: an island showing a variable that differs at runtime hydrates with a mismatch, so a page showing one renders per request.
- The server refuses to boot when `publicEnv` declares a name such as `STRIPE_SECRET`, `DB_PASSWORD`, `PRIVATE_KEY`, `ACCESS_TOKEN`, `API_KEY` or `DATABASE_URL`, which every visitor would read; keep those in `defineEnv`. A name ending in `_KEY` otherwise, such as `MAP_KEY`, passes.
- Only the declared variables leave the server, and nothing else of the environment reaches an island: a module reading `process.env` or `defineEnv`'s values fails the browser build.
- Reading `publicEnv` when the config declares none throws; a name it does not declare is a type error.
