// The build side of @kayjs/icons: resolves `~icons/<set>/<name>` imports to inline SVG data at compile time, and adds `kay icons-find`.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/config'
import type { IconSet } from './types'
import { definePlugin } from '@kayjs/kay/config'
import { iconData } from './icon-data'
import { installedSets, isSetPrefix, setFile } from './sets'

const FOUND_PER_SET = 10
const ICON_SPEC_RE = /^~icons\/([^/]+)\/(.+)$/
const SELF_CLOSING_RE = /<([a-z][\w:-]*)([^<>]*?)\s*\/>/gi

// Spells `<path d="…"/>` as `<path d="…"></path>`, the way a browser serializes SVG, so hydrating an island finds the server's body unchanged and keeps its nodes.
function withEndTags(body: string): string {
  return body.replace(SELF_CLOSING_RE, '<$1$2></$1>')
}

async function readSet(prefix: string, root: string): Promise<IconSet> {
  const file = setFile(prefix, root)
  if (file === undefined) {
    throw new Error(isSetPrefix(prefix)
      ? `@kayjs/icons: no icon set "${prefix}" is installed: install @iconify-json/${prefix}, or pass it in icons({ sets }).`
      : `@kayjs/icons: "${prefix}" is not an icon set name: write ~icons/<set>/<name>, such as ~icons/tabler/home.`)
  }
  return await Bun.file(file).json() as IconSet
}

export interface IconsPluginOptions {
  /** Optional preloaded custom icon sets keyed by prefix (e.g. `{ custom: mySet }`). */
  sets?: Record<string, IconSet> | undefined
}

export function icons(options: IconsPluginOptions = {}): KayPlugin {
  // The in-flight read of each set, so icons loaded in parallel parse their set once.
  const cache = new Map<string, Promise<IconSet>>(Object.entries(options.sets ?? {}).map(([prefix, set]) => [prefix, Promise.resolve(set)]))
  const loadSet = (prefix: string, root: string): Promise<IconSet> => {
    let set = cache.get(prefix)
    if (set === undefined) {
      set = (async () => {
        try {
          return await readSet(prefix, root)
        }
        catch (error) {
          cache.delete(prefix)
          throw error
        }
      })()
      cache.set(prefix, set)
    }
    return set
  }

  return definePlugin({
    name: '@kayjs/icons',
    bunPlugins: ({ root, target }): BunPlugin[] => [{
      name: 'kayjs-icons',
      setup(b) {
        b.onResolve({ filter: ICON_SPEC_RE }, args => ({ path: args.path, namespace: 'kay-icon' }))

        b.onLoad({ filter: /.*/, namespace: 'kay-icon' }, async (args) => {
          const match = ICON_SPEC_RE.exec(args.path)
          if (match === null)
            throw new Error(`@kayjs/icons: invalid specifier "${args.path}" (expected ~icons/<prefix>/<name>)`)

          const prefix = match[1]!
          const name = match[2]!
          const data = iconData(await loadSet(prefix, root), name)
          if (data === undefined)
            throw new Error(`@kayjs/icons: icon "${name}" not found in set "${prefix}"`)

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
