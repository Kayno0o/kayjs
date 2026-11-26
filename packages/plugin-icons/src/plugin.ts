// The build side of @kayjs/icons: resolves `~icons/<set>/<name>` imports to inline SVG data at compile time, and adds `kay icons-find`.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/config'
import type { IconSet } from './types'
import { join } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'
import { iconData } from './icon-data'

const FOUND_PER_SET = 10
const ICON_SPEC_RE = /^~icons\/([^/]+)\/(.+)$/

function resolveIconSetFile(prefix: string, root: string): string {
  const pkgPath = `@iconify-json/${prefix}/icons.json`
  for (const from of [root, process.cwd()]) {
    try {
      return Bun.resolveSync(pkgPath, from)
    }
    catch {}
  }
  throw new Error(`@kayjs/icons: could not resolve "${pkgPath}". Install @iconify-json/${prefix}.`)
}

export interface IconsPluginOptions {
  /** Optional preloaded custom icon sets keyed by prefix (e.g. `{ custom: mySet }`). */
  sets?: Record<string, IconSet> | undefined
}

export function icons(options: IconsPluginOptions = {}): KayPlugin {
  const cache = new Map<string, IconSet>(Object.entries(options.sets ?? {}))

  return definePlugin({
    name: '@kayjs/icons',
    bunPlugins: ({ root }): BunPlugin[] => [{
      name: 'kayjs-icons',
      setup(b) {
        b.onResolve({ filter: ICON_SPEC_RE }, args => ({ path: args.path, namespace: 'kay-icon' }))

        b.onLoad({ filter: /.*/, namespace: 'kay-icon' }, async (args) => {
          const match = ICON_SPEC_RE.exec(args.path)
          if (match === null)
            throw new Error(`@kayjs/icons: invalid specifier "${args.path}" (expected ~icons/<prefix>/<name>)`)

          const prefix = match[1]!
          const name = match[2]!
          let set = cache.get(prefix)

          if (set === undefined) {
            set = await Bun.file(resolveIconSetFile(prefix, root)).json() as IconSet
            cache.set(prefix, set)
          }

          const data = iconData(set, name)
          if (data === undefined)
            throw new Error(`@kayjs/icons: icon "${name}" not found in set "${prefix}"`)

          return {
            contents: `export default ${JSON.stringify(data)};\n`,
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

        const files = [...new Bun.Glob('node_modules/@iconify-json/*/icons.json').scanSync({ cwd: root, followSymlinks: true })].sort()
        if (files.length === 0) {
          console.error('No icon set installed. Install one, such as @iconify-json/tabler.')
          process.exit(1)
        }

        // Imported here so the word table never reaches a bundle that only draws icons.
        const { findIcons } = await import('./search')
        for (const file of files) {
          const set = await Bun.file(join(root, file)).json() as IconSet
          for (const name of findIcons(set, query, { limit: FOUND_PER_SET }))
            console.log(`~icons/${set.prefix}/${name}`)
        }
      },
    },
  })
}
