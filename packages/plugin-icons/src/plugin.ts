// The build side of @kayjs/icons: resolves `~icons/<set>/<name>` imports to inline SVG data at compile time, and adds `kay icons-find`.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/config'
import type { IconLookup } from './diagnose'
import type { IconSet } from './types'
import { join, relative } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'
import { iconData } from './icon-data'
import { iconProblem } from './diagnose'
import { installedSets, setFile } from './sets'

const FOUND_PER_SET = 10
const ICON_SPEC_RE = /^~icons\/([^/]+)\/(.+)$/
const SEARCH_ENTRY_RE = /^@kayjs\/icons\/search$/
const ICON_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(~icons\/[^/'"]+\/[^'"]+)\1/g
const SELF_CLOSING_RE = /<([a-z][\w:-]*)([^<>]*?)\s*\/>/gi

// Spells `<path d="…"/>` as `<path d="…"></path>`, the way a browser serializes SVG, so hydrating an island finds the server's body unchanged and keeps its nodes.
function withEndTags(body: string): string {
  return body.replace(SELF_CLOSING_RE, '<$1$2></$1>')
}

export interface IconsPluginOptions {
  /** Optional preloaded custom icon sets keyed by prefix (e.g. `{ custom: mySet }`). */
  sets?: Record<string, IconSet> | undefined
}

function lineAndColumn(code: string, offset: number): string {
  const before = code.slice(0, offset).split('\n')
  return `${before.length}:${before.at(-1)!.length + 1}`
}

export function icons(options: IconsPluginOptions = {}): KayPlugin {
  // The in-flight read of each set, so icons loaded in parallel parse their set once; a set not installed is looked for again next time.
  const cache = new Map<string, Promise<IconSet | undefined>>(Object.entries(options.sets ?? {}).map(([prefix, set]) => [prefix, Promise.resolve(set)]))
  const lookupIn = (root: string): IconLookup => ({
    set: (prefix) => {
      let set = cache.get(prefix)
      if (set === undefined) {
        const file = setFile(prefix, root)
        if (file === undefined)
          return Promise.resolve(undefined)
        set = Bun.file(file).json() as Promise<IconSet>
        cache.set(prefix, set)
      }
      return set
    },
    prefixes: () => [...new Set([...Object.keys(options.sets ?? {}), ...installedSets(root).keys()])],
  })

  return definePlugin({
    name: '@kayjs/icons',
    async check(ctx) {
      const lookup = lookupIn(ctx.root)
      for (const file of new Bun.Glob('src/**/*.{ts,tsx,mts}').scanSync({ cwd: ctx.root })) {
        const code = await Bun.file(join(ctx.root, file)).text()
        for (const found of code.matchAll(ICON_IMPORT_RE)) {
          const [, prefix, name] = ICON_SPEC_RE.exec(found[2]!)!
          const problem = await iconProblem(prefix!, name!, '', lookup)
          if (problem !== undefined)
            ctx.error(`${file}:${lineAndColumn(code, found.index + found[0].length - found[2]!.length - 2)}: error: @kayjs/icons: ${problem}`)
        }
      }
    },
    bunPlugins: ({ root, target }): BunPlugin[] => [{
      name: 'kayjs-icons',
      setup(b) {
        const lookup = lookupIn(root)
        if (target === 'client') {
          b.onResolve({ filter: SEARCH_ENTRY_RE }, (args) => {
            console.warn(`@kayjs/icons: ${relative(root, args.importer)} imports @kayjs/icons/search into an island, which ships its 2.3 MB word table to the browser. Search on the server instead, in a route or an action.`)
            return undefined
          })
        }
        // The first file importing each icon, for an error to name it.
        const importers = new Map<string, string>()
        b.onResolve({ filter: ICON_SPEC_RE }, (args) => {
          if (!importers.has(args.path))
            importers.set(args.path, relative(root, args.importer))
          return { path: args.path, namespace: 'kay-icon' }
        })

        b.onLoad({ filter: /.*/, namespace: 'kay-icon' }, async (args) => {
          const [, prefix, name] = ICON_SPEC_RE.exec(args.path)!
          const set = await lookup.set(prefix!)
          const data = set === undefined ? undefined : iconData(set, name!)
          if (data === undefined)
            throw new Error(`@kayjs/icons: ${await iconProblem(prefix!, name!, `, imported by ${importers.get(args.path)}`, lookup)}`)

          return {
            contents: `export default ${JSON.stringify(target === 'client' ? { ...data, body: withEndTags(data.body) } : data)};\n`,
            loader: 'js',
          }
        })
      },
    }],
    commands: {
      // Prints the `~icons/<set>/<name>` specifiers of the installed sets matching the words, so an agent imports icons that exist.
      'icons-find': async (args, root) => {
        const query = args.join(' ')
        if (query.trim() === '') {
          console.error('Usage: kay icons-find <words>')
          process.exit(1)
        }

        const files = [...installedSets(root).values()]
        if (files.length === 0) {
          console.error('No icon set installed. Install one, such as @iconify-json/tabler.')
          process.exit(1)
        }

        // Imported here so the word table never reaches a bundle that only draws icons.
        const { findIcons } = await import('./search')
        for (const file of files) {
          const set = await Bun.file(file).json() as IconSet
          for (const name of findIcons(set, query, { limit: FOUND_PER_SET }))
            console.log(`~icons/${set.prefix}/${name}`)
        }
      },
    },
  })
}
