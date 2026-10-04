import type { IconProps } from '../runtime/icons'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface IconifyIcon {
  body?: string
  parent?: string
  width?: number
  height?: number
  left?: number
  top?: number
  rotate?: number
  hFlip?: boolean
  vFlip?: boolean
}

interface IconifySet {
  prefix: string
  icons: Record<string, IconifyIcon>
  aliases?: Record<string, IconifyIcon>
  width?: number
  height?: number
}

// `import home from '~icons/tabler/home'`: an icon of a set the project installs as `@iconify-json/<prefix>`.
export const ICON_IMPORT = /^~icons\/([a-z0-9-]+)\/([a-z0-9-]+)$/
const ICONIFY_PACKAGE = '@iconify-json/'
// Iconify's default box, for a set that declares none.
const DEFAULT_SIZE = 16
const sets = new Map<string, IconifySet | undefined>()

// The `@iconify-json/*` packages the project depends on, by prefix, with the file holding each set.
export function installedIconSets(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const manifest = join(root, 'package.json')

  if (!existsSync(manifest))
    return found

  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string>, devDependencies?: Record<string, string> }

  for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
    if (!name.startsWith(ICONIFY_PACKAGE))
      continue

    try {
      found.set(name.slice(ICONIFY_PACKAGE.length), Bun.resolveSync(`${name}/icons.json`, root))
    }
    catch {
      // Listed but not installed yet: its icons are reported missing until `bun install` runs.
    }
  }

  return found
}

function readSet(file: string): IconifySet | undefined {
  if (!sets.has(file))
    sets.set(file, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as IconifySet : undefined)

  return sets.get(file)
}

// Every icon and alias of a set file, as `prefix/name`.
export function iconNames(prefix: string, file: string): string[] {
  const set = readSet(file)

  return set ? [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})].map(name => `${prefix}/${name}`) : []
}

// The props an `svg` spreads to draw the icon, its box from the set and its markup inlined; undefined when the set has no such icon.
export function iconProps(file: string, name: string): IconProps | undefined {
  const set = readSet(file)
  const icon = set && resolveIcon(set, name, 0)

  if (!set || !icon?.body)
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

  if (icon.rotate)
    transforms.push(`rotate(${(icon.rotate % 4) * 90} ${left + width / 2} ${top + height / 2})`)

  return {
    'viewBox': `${left} ${top} ${width} ${height}`,
    'width': `${Math.round(width / height * 1000) / 1000}em`,
    'height': '1em',
    'aria-hidden': 'true',
    'innerHTML': transforms.length > 0 ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body,
  }
}

// An alias takes its parent's body and box, its own fields winning; flips toggle and rotations add up along the chain.
function resolveIcon(set: IconifySet, name: string, depth: number): IconifyIcon | undefined {
  const own = set.icons[name]

  if (own)
    return own

  const alias = set.aliases?.[name]

  if (!alias?.parent || depth > 8)
    return undefined

  const parent = resolveIcon(set, alias.parent, depth + 1)

  if (!parent)
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

// The module an icon import loads, or one throwing on use with what went wrong.
export function iconModule(sets: Map<string, string>, specifier: string): string {
  const [, prefix, name] = ICON_IMPORT.exec(specifier) ?? []
  const file = prefix === undefined ? undefined : sets.get(prefix)

  if (!file)
    throw new Error(`kay: ${specifier} names no installed icon set; add it with \`bun add -d ${ICONIFY_PACKAGE}${prefix ?? '<prefix>'}\``)

  const props = iconProps(file, name!)

  if (!props)
    throw new Error(`kay: ${ICONIFY_PACKAGE}${prefix} has no icon named ${name}`)

  return `export default ${JSON.stringify(props)}`
}

// One module declaration per icon of the installed sets, so a misspelt name fails to type-check as a missing module.
export function iconTypes(root: string): string {
  const names = [...installedIconSets(root)].flatMap(([prefix, file]) => iconNames(prefix, file))
  const declarations = names.map(name => `declare module '~icons/${name}' {\n  const icon: import('kay/icons').IconProps\n  export default icon\n}\n`)

  return `// Written by kay from the @iconify-json packages the project depends on.\n${declarations.join('')}`
}
