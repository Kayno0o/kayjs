import type { IconProps, IconSet } from '../runtime/icons'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KayError } from '../compiler/errors'
import * as iconSet from '../runtime/icons'

// `import home from '~icons/tabler/home'`: an icon of a set the project installs as `@iconify-json/<prefix>`.
export const ICON_IMPORT = /^~icons\/([a-z0-9-]+)\/([a-z0-9-]+)$/
const ICONIFY_PACKAGE = '@iconify-json/'
const sets = new Map<string, IconSet | undefined>()

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

function readSet(file: string): IconSet | undefined {
  if (!sets.has(file))
    sets.set(file, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as IconSet : undefined)

  return sets.get(file)
}

// Every icon and alias of a set file, as `prefix/name`.
export function iconNames(prefix: string, file: string): string[] {
  const set = readSet(file)

  return set ? iconSet.iconNames(set).map(name => `${prefix}/${name}`) : []
}

// The props an `svg` spreads to draw the icon; undefined when the set has no such icon.
export function iconProps(file: string, name: string): IconProps | undefined {
  const set = readSet(file)

  return set && iconSet.iconProps(set, name)
}

// Where the runtime keeps the mark an icon's markup carries, which the module marks it with.
export const VOUCH_MODULE = fileURLToPath(new URL('../runtime/safe-html.ts', import.meta.url))

// The module an icon import loads, or one throwing on use with what went wrong.
export function iconModule(sets: Map<string, string>, specifier: string): string {
  const [, prefix, name] = ICON_IMPORT.exec(specifier) ?? []
  const file = prefix === undefined ? undefined : sets.get(prefix)

  if (file === undefined)
    throw new KayError('icon-unresolved', `kay: ${specifier} names no installed icon set; add it with \`bun add -d ${ICONIFY_PACKAGE}${prefix ?? '<prefix>'}\``)

  const props = iconProps(file, name!)

  if (!props)
    throw new KayError('icon-unresolved', `kay: ${ICONIFY_PACKAGE}${prefix} has no icon named ${name}`)

  // The call is marked pure, so a bundle drops an icon nothing uses, which a statement setting `innerHTML` beside the object would keep.
  return `import { vouchedIcon } from ${JSON.stringify(VOUCH_MODULE)}\nexport default /* @__PURE__ */ vouchedIcon(${JSON.stringify(props)})\n`
}

// One module declaration per icon of the installed sets, so a misspelt name fails to type-check as a missing module.
export function iconTypes(root: string): string {
  const names = [...installedIconSets(root)].flatMap(([prefix, file]) => iconNames(prefix, file))
  const declarations = names.map(name => `declare module '~icons/${name}' {\n  const icon: import('kay/icons').IconProps\n  export default icon\n}\n`)

  return `// Written by kay from the @iconify-json packages the project depends on.\n${declarations.join('')}`
}
