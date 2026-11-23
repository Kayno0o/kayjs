// @kayjs/icons — Zero-runtime inline SVG icons from @iconify-json/* via `import arrow from '~icons/tabler/arrow-right'`.
// Built strictly on the public KayPlugin API (bunPlugins).

import type { BunPlugin } from 'bun'
import type { KayPlugin } from 'kay/server'
import type { IconData, IconifyIcon, IconSet } from './types'

export { Icon } from './Icon'
export type { IconComponentProps } from './Icon'
export type { IconData, IconifyIcon, IconSet } from './types'

const DEFAULT_SIZE = 16

function resolveIcon(set: IconSet, name: string, depth: number): IconifyIcon | undefined {
  const own = set.icons[name]
  if (own !== undefined)
    return own

  const alias = set.aliases?.[name]
  if (alias?.parent === undefined || alias.parent === '' || depth > 8)
    return undefined

  const parent = resolveIcon(set, alias.parent, depth + 1)
  if (parent === undefined)
    return undefined

  return {
    ...parent,
    ...alias,
    body: parent.body,
    hFlip: Boolean(parent.hFlip) !== Boolean(alias.hFlip),
    vFlip: Boolean(parent.vFlip) !== Boolean(alias.vFlip),
    rotate: (parent.rotate ?? 0) + (alias.rotate ?? 0),
  }
}

export function iconData(set: IconSet, name: string): IconData | undefined {
  const ownPrefix = `${set.prefix}:`
  const icon = resolveIcon(set, name.startsWith(ownPrefix) ? name.slice(ownPrefix.length) : name, 0)
  if (icon?.body === undefined || icon.body === '')
    return undefined

  const width = icon.width ?? set.width ?? DEFAULT_SIZE
  const height = icon.height ?? set.height ?? DEFAULT_SIZE
  const left = icon.left ?? 0
  const top = icon.top ?? 0
  const transforms: string[] = []

  if (icon.hFlip)
    transforms.push(`translate(${left * 2 + width} 0) scale(-1 1)`)
  if (icon.vFlip)
    transforms.push(`translate(0 ${top * 2 + height}) scale(1 -1)`)
  if (icon.rotate !== undefined && icon.rotate !== 0)
    transforms.push(`rotate(${(icon.rotate % 4) * 90} ${left + width / 2} ${top + height / 2})`)

  const body = transforms.length > 0 ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body

  return {
    viewBox: `${left} ${top} ${width} ${height}`,
    width: `${Math.round((width / height) * 1000) / 1000}em`,
    height: '1em',
    body,
  }
}

export interface IconsPluginOptions {
  /** Optional preloaded custom icon sets keyed by prefix (e.g. `{ custom: mySet }`). */
  sets?: Record<string, IconSet> | undefined
}

export function icons(options: IconsPluginOptions = {}): KayPlugin {
  const cache = new Map<string, IconSet>(Object.entries(options.sets ?? {}))

  return {
    name: '@kayjs/icons',
    bunPlugins: ({ root }): BunPlugin[] => [{
      name: 'kayjs-icons',
      setup(b) {
        b.onResolve({ filter: /^~icons\/([^/]+)\/(.+)$/ }, (args) => {
          return { path: args.path, namespace: 'kay-icon' }
        })

        b.onLoad({ filter: /.*/, namespace: 'kay-icon' }, async (args) => {
          const match = /^~icons\/([^/]+)\/(.+)$/.exec(args.path)
          if (match === null)
            throw new Error(`@kayjs/icons: invalid specifier "${args.path}" (expected ~icons/<prefix>/<name>)`)

          const prefix = match[1]!
          const name = match[2]!
          let set = cache.get(prefix)

          if (set === undefined) {
            const pkgPath = `@iconify-json/${prefix}/icons.json`
            let resolved: string
            try {
              resolved = Bun.resolveSync(pkgPath, root)
            }
            catch {
              throw new Error(`@kayjs/icons: could not resolve "${pkgPath}". Install @iconify-json/${prefix}.`)
            }
            set = await Bun.file(resolved).json() as IconSet
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
  }
}
