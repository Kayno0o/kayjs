# Compile a component from a tool

## Common tasks

### Report a component's problems from a tool

`kay/compiler` is for a tool that reads `.kay` source outside kay, such as a formatter, a docs checker or a CSS scanner; it exports `compileKay`, `formatDiagnostic` and the types `Diagnostic`, `CompileOptions` and `CompileResult`:

```ts
import { compileKay, formatDiagnostic } from 'kay/compiler'

const source = await Bun.file('src/routes/index.kay').text()
const { diagnostics, classes } = compileKay(source, 'src/routes/index.kay')

for (const diagnostic of diagnostics)
  console.error(formatDiagnostic(source, 'src/routes/index.kay', diagnostic))
```

## Reference

- `compileKay(source, filename, options?)` returns `{ tsx, map, island?, cause?, classes, diagnostics }`, `cause` being what makes the component an island: `{ kind, name, span, line, source? }`, `span` the offsets in the source and `source` the module of a `kay` value. `why` is the same cause as a sentence, deprecated for `cause`. A problem in the source is reported in `diagnostics`. `filename` is read for its base name and, with `root`, its island id: a `_layout.kay`, `_404.kay` or `_error.kay`, like a file with a `--- server` fence, is a route file the server renders, never an island.
- `tsx` is the generated code: TSX for type checking by default, or with `output: 'html'` or `output: 'dom'` the server's or the browser's code that runs. `map` maps it back to the source, `island` is the component's island id when it renders as one, `classes` the `.class` shorthand names a CSS scanner cannot read off the template.
- Options: `root` (island ids are paths relative to it), `includeServer: false` for a browser build, `params` and `paramTypes` typing `ctx.params`, `check: true` for the type-checking output's link, form field and island prop assertions plus the lints, with `lints` setting their levels, `inspect` for `data-kay-src`, and `hydratable`, `twinBuild`, `clientOnly`, `insideIsland` and `importedSignals`, which kay's own build sets.
- A `Diagnostic` is `{ start, end, message, label?, related?, note?, help?, code?, severity?, fixes? }`, `start` and `end` offsets into `source`, `code` a lint's name, `severity` `'warning'` for a lint at the `warn` level.
- `formatDiagnostic(source, filename, diagnostic, paint?)` prints it as `kay check` does, with the file, line and column, the source line and its `help`; `paint` is `(styles, text) => string` for colour, plain text without it.
