import type { BunPlugin } from 'bun'
import type { ClientOptions } from '../build/client'
import { readFileSync } from 'node:fs'
import { plugin } from 'bun'

// Plugins that load a native addon, which Bun keeps its global alive for: under `bun test --isolate` every file then pins its whole module graph for the rest of the run. Each maps to the `name` of the plugin it holds, which the shim carries so builds keyed on plugin names (`runtime-search-build.json`) share a slot with a `kay build`.
export const NATIVE_PLUGINS: Record<string, string> = { 'bun-plugin-tailwind': '@tailwindcss/bun' }
const ENTRY = new RegExp(`[\\\\/]node_modules[\\\\/](${Object.keys(NATIVE_PLUGINS).join('|')})[\\\\/]index\\.mjs$`)
const STYLESHEET = /\.css$/
const STYLE_MODULE = /\.module\.css$/
const EXPORT_STAR = /(?:^|[;{}\n])[ \t]*export\s*\*\s*from\b/
const transpiler = new Bun.Transpiler({ loader: 'js' })
let registered = false
const shims = new Map<string, string>()

// The shim: `default` runs the real plugin, loaded when a build runs it. The other exports are live bindings filled in once the real module loads, as an ES module cannot export a value it has not read. The real file is imported again with a query, which the filter does not match. A bundle re-exporting with `export *` cannot be listed by a scan, so it fails the import instead of missing exports. The scan of a bundle of about 1 MB runs once per module instance, so once per test file under `--isolate`.
export function shim(name: string, real: string): string {
  const cached = shims.get(real)

  if (cached !== undefined)
    return cached

  const source = readFileSync(real, 'utf8')

  if (EXPORT_STAR.test(source))
    throw new Error(`kay/test: ${real} uses \`export *\`, which the lazy shim of NATIVE_PLUGINS cannot list; list its exports in src/test/lazy-plugins.ts first`)

  const others = transpiler.scan(source).exports.filter(one => one !== 'default')
  const declared = others.map((one, index) => `let v${index}; export { v${index} as ${JSON.stringify(one)} }`).join('\n')
  const filled = others.map((one, index) => `v${index} = real[${JSON.stringify(one)}]`).join('; ')
  const text = `${declared}
export default {
  name: ${JSON.stringify(NATIVE_PLUGINS[name])},
  kayNative: true,
  async setup(build) {
    const real = await import(${JSON.stringify(`${real}?real`)})
    ${filled}
    return real.default.setup(build)
  },
}
`

  shims.set(real, text)

  return text
}

// A config importing one of NATIVE_PLUGINS gets a plugin that loads the real one when a build runs it, not when the config is read, so a file that never builds a client for a browser loads no addon. Bun resolves the import from the project as usual, so each project meets its own.
export function lazyNativePlugins(): void {
  if (registered)
    return

  registered = true

  plugin({
    name: 'kay-lazy-natives',
    setup(build) {
      build.onLoad({ filter: ENTRY }, ({ path }) => ({ contents: shim(ENTRY.exec(path)![1]!, path), loader: 'js' }))
    },
  })
}

const START_NOT_IDENTIFIER = /^(?:\d|-\d)/
const WORD_BEFORE = /[\w-]$/
const NEWLINE = /[\n\r\f]/
const PSEUDO_BEFORE = /:[\w-]+$/
const SELECTOR_AT_RULES = new Set(['scope', 'custom-selector'])
const AT_NAME = /^@[\w-]+/
const NAME_CHAR = /[\w-]/
const URL_BEFORE = /url$/i
const HEX = /^[\da-f]{1,6}/i
const WHITESPACE = /\s/

// The end of a quoted string starting at `start`, whose escapes are skipped, or of its line when it is never closed, as CSS ends a bad string.
function stringEnd(css: string, start: number): number {
  const quote = css[start]
  let index = start + 1

  while (index < css.length && css[index] !== quote && css[index] !== '\n')
    index += css[index] === '\\' ? 2 : 1

  return css[index] === quote ? index + 1 : index
}

// The end of a `url(` whose opening parenthesis is at `open`: a quoted argument ends at its quote, an unquoted one at the first unescaped `)`.
function urlEnd(css: string, open: number): number {
  let index = open + 1

  while (WHITESPACE.test(css[index] ?? ''))
    index++

  if (css[index] === '"' || css[index] === '\'')
    index = stringEnd(css, index)

  while (index < css.length && css[index] !== ')')
    index += css[index] === '\\' ? 2 : 1

  return index + 1
}

// The end of a parenthesised group opened at `start`, past nested ones, strings, comments and escapes.
function parenEnd(css: string, start: number): number {
  let depth = 0
  let index = start

  while (index < css.length) {
    const char = css[index]!

    if (char === '"' || char === '\'') {
      index = stringEnd(css, index)

      continue
    }

    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)

      index = end < 0 ? css.length : end + 2

      continue
    }

    index += char === '\\' ? 2 : 1

    if (char === '(')
      depth++
    else if (char === ')' && --depth === 0)
      return index
  }

  return css.length
}

// The end of an at-rule prelude, at its `;` or `{`, which are left to the caller.
function preludeEnd(css: string, start: number): number {
  let index = start

  while (index < css.length && css[index] !== ';' && css[index] !== '{') {
    const char = css[index]!

    if (char === '"' || char === '\'')
      index = stringEnd(css, index)
    else if (char === '(')
      index = parenEnd(css, index)
    else if (char === '/' && css[index + 1] === '*')
      index = !css.includes('*/', index + 2) ? css.length : css.indexOf('*/', index + 2) + 2
    else
      index += char === '\\' ? 2 : 1
  }

  return index
}

// The class name starting right after a dot, with escapes decoded and non-ASCII characters kept, and where it ends. Following the CSS Syntax identifier rules: a name starting with a digit, a dash and a digit (unescaped), or a lone dash is none (`0.5em`).
function identifier(css: string, start: number): { name: string, end: number } | undefined {
  let index = start
  let name = ''

  while (index < css.length) {
    const char = css[index]!

    if (char === '\\') {
      const hex = HEX.exec(css.slice(index + 1, index + 7))?.[0]

      if (hex === undefined) {
        if (index + 1 >= css.length || NEWLINE.test(css[index + 1]!))
          break

        const next = String.fromCodePoint(css.codePointAt(index + 1)!)

        name += next
        index += 1 + next.length

        continue
      }

      const code = Number.parseInt(hex, 16)

      name += String.fromCodePoint(code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? 0xFFFD : code)
      index += 1 + hex.length

      if (css.startsWith('\r\n', index))
        index += 2
      else if (WHITESPACE.test(css[index] ?? ''))
        index++

      continue
    }

    if (!NAME_CHAR.test(char) && char.charCodeAt(0) < 0x80)
      break

    name += char
    index++
  }

  return name === '' || name === '-' || START_NOT_IDENTIFIER.test(css.slice(start, start + 2)) ? undefined : { name, end: index }
}

// Every class name the selectors of a stylesheet mention, found by one pass that skips comments, strings and `url()` arguments.
export function classNameList(css: string): string[] {
  const names = new Set<string>()
  let index = 0

  while (index < css.length) {
    const char = css[index]!

    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)

      index = end < 0 ? css.length : end + 2
    }
    else if (char === '"' || char === '\'') {
      index = stringEnd(css, index)
    }
    else if (char === '@') {
      const name = AT_NAME.exec(css.slice(index, index + 64))?.[0]

      index += name?.length ?? 1

      if (name !== undefined && !SELECTOR_AT_RULES.has(name.slice(1).toLowerCase()))
        index = preludeEnd(css, index)
    }
    else if (char === '(' && URL_BEFORE.test(css.slice(Math.max(0, index - 3), index))) {
      index = urlEnd(css, index)
    }
    else if (char === '(' && WORD_BEFORE.test(css.slice(Math.max(0, index - 1), index)) && !PSEUDO_BEFORE.test(css.slice(Math.max(0, index - 64), index))) {
      index = parenEnd(css, index)
    }
    else if (char === '.') {
      const found = identifier(css, index + 1)

      if (found)
        names.add(found.name)

      index = found?.end ?? index + 1
    }
    else {
      index++
    }
  }

  return [...names]
}

// What a stylesheet module exports without being parsed: every class name, as the default object and as a named export, a string name so a reserved word such as `new` exports too.
function classNames(css: string): string {
  const names = classNameList(css)
  const named = names.filter(name => name !== 'default').map((name, index) => `const v${index} = ${JSON.stringify(name)}; export { v${index} as ${JSON.stringify(name)} }`)

  return `export default Object.fromEntries([${names.map(name => `[${JSON.stringify(name)}, ${JSON.stringify(name)}]`).join(', ')}])\n${named.join('\n')}\n`
}

// The options of a build only run as a check, whose stylesheets nothing reads: a native plugin is swapped for one answering every stylesheet with an empty one, so no addon loads and Bun's own CSS parser, which fails on Tailwind's `source(...)`, never sees them.
export function checkOnly(options: ClientOptions): ClientOptions {
  if (options.plugins === undefined)
    return options

  const emptyStyles = (name: string): BunPlugin => ({
    name,
    setup(build) {
      build.onLoad({ filter: STYLE_MODULE }, async ({ path }) => ({ contents: classNames(await Bun.file(path).text()), loader: 'js' }))
      build.onLoad({ filter: STYLESHEET }, () => ({ contents: '', loader: 'css' }))
    },
  })

  return { ...options, plugins: options.plugins.map(one => (one as BunPlugin & { kayNative?: boolean }).kayNative ? emptyStyles(one.name ?? 'kay-native') : one) }
}
