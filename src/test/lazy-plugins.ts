import type { BunPlugin } from 'bun'
import type { ClientOptions } from '../build/client'
import { readFileSync } from 'node:fs'
import { plugin } from 'bun'

// Plugins that load a native addon, which Bun keeps its global alive for: under `bun test --isolate` every file then pins its whole module graph for the rest of the run. Each maps to the `name` of the plugin it holds, which the shim carries so builds keyed on plugin names (`runtime-search-build.json`) share a slot with a `kay build`.
export const NATIVE_PLUGINS: Record<string, string> = { 'bun-plugin-tailwind': '@tailwindcss/bun' }
const ENTRY = new RegExp(`[\\\\/]node_modules[\\\\/](${Object.keys(NATIVE_PLUGINS).join('|')})[\\\\/]index\\.mjs$`)
const STYLESHEET = /\.css$/
const STYLE_MODULE = /\.module\.css$/
const COMMENTS_STRINGS_URLS = /\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)/g
const CLASS_NAME = /\.(-?[_a-z][\w-]*)/gi
const transpiler = new Bun.Transpiler({ loader: 'js' })
let registered = false

// The shim: `default` runs the real plugin, loaded when a build runs it. The other exports are live bindings filled in once the real module loads, as an ES module cannot export a value it has not read. The real file is imported again with a query, which the filter does not match. Only plain `export` names are followed, which the plugins listed here use.
function shim(name: string, real: string): string {
  const others = transpiler.scan(readFileSync(real, 'utf8')).exports.filter(one => one !== 'default')
  const declared = others.map(one => `export let ${one}`).join('\n')
  const filled = others.map(one => `${one} = real.${one}`).join('; ')

  return `${declared}
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

// What a stylesheet module exports without being parsed: every class name its selectors mention, as the default object and as a named export, a string name so a reserved word such as `new` exports too.
function classNames(css: string): string {
  const names = [...new Set([...css.replace(COMMENTS_STRINGS_URLS, '').matchAll(CLASS_NAME)].map(match => match[1]!))]
  const named = names.filter(name => name !== 'default').map((name, index) => `const v${index} = ${JSON.stringify(name)}; export { v${index} as ${JSON.stringify(name)} }`)

  return `export default { ${names.map(name => `${JSON.stringify(name)}: ${JSON.stringify(name)}`).join(', ')} }\n${named.join('\n')}\n`
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
