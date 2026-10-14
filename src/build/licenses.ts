import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { installedIconSets } from './icons'

// Written beside the browser build, so it reaches every host serving `/_kay/`, and carried by an executable for `--licenses`.
export const NOTICES_FILE = 'THIRD-PARTY-LICENSES.txt'

const NODE_MODULES = `${sep}node_modules${sep}`
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][\w.-]*)?$/i
// What asks nothing more than its notice kept with the copy, which the notices file is; an icon set under anything else is warned about.
const NOTICE_ENOUGH = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Unlicense', 'OFL-1.1', 'MPL-2.0'])
const RULE = '='.repeat(80)

interface PackageJson {
  name?: string
  version?: string
  license?: string | { type?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface IconSetInfo {
  name?: string
  author?: { name?: string, url?: string }
  license?: { title?: string, spdx?: string, url?: string }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return undefined
  }
}

// The directory of the package a file under `node_modules` belongs to, a scoped one included.
export function packageDirOf(file: string): string | undefined {
  const at = file.lastIndexOf(NODE_MODULES)

  if (at === -1)
    return undefined

  const start = at + NODE_MODULES.length
  const [first, second] = file.slice(start).split(sep)

  if (first === undefined || (first.startsWith('@') && second === undefined))
    return undefined

  return join(file.slice(0, start), first, ...first.startsWith('@') ? [second!] : [])
}

// The packages the files a build ships come from, each once.
export function packagesOf(files: Iterable<string>): string[] {
  const dirs = new Set<string>()

  for (const file of files) {
    const dir = packageDirOf(resolve(file))

    if (dir !== undefined)
      dirs.add(dir)
  }

  return [...dirs]
}

// Where `name` resolves from `from`, as Bun finds it: the nearest `node_modules` holding it, up the tree.
function installedPackage(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)

    if (existsSync(join(candidate, 'package.json')))
      return candidate

    if (dirname(dir) === dir)
      return undefined
  }
}

// Every package the project's dependencies install, theirs included, as an executable bundled from them may carry any; its dev dependencies are left out.
export function installedDependencies(root: string): string[] {
  const found = new Set<string>()
  const visit = (from: string, names: string[]) => {
    for (const name of names) {
      const dir = installedPackage(from, name)
      const real = dir === undefined ? undefined : realpathSync(dir)

      if (real === undefined || found.has(real))
        continue

      found.add(real)

      const manifest = readJson<PackageJson>(join(real, 'package.json'))

      visit(real, Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies, ...manifest?.peerDependencies }))
    }
  }
  const manifest = readJson<PackageJson>(join(root, 'package.json'))

  visit(root, Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies }))

  return [...found]
}

function iconSetInfo(dir: string): IconSetInfo | undefined {
  return readJson<IconSetInfo>(join(dir, 'info.json')) ?? readJson<{ info?: IconSetInfo }>(join(dir, 'icons.json'))?.info
}

// The icon sets the project depends on: pages inline their paths, so each is shipped whether an island draws it or the server does.
export function iconSetPackages(root: string): string[] {
  return [...installedIconSets(root).values()].map(file => dirname(file))
}

// One line per icon set whose licence asks for more than the notice, such as CC BY's credit where the icons show.
export function iconSetWarnings(root: string): string[] {
  return [...installedIconSets(root)].flatMap(([prefix, file]) => {
    const { name = prefix, author, license } = iconSetInfo(dirname(file)) ?? {}

    if (license?.spdx !== undefined && NOTICE_ENOUGH.has(license.spdx))
      return []

    const terms = license?.title ?? license?.spdx ?? 'a licence its package does not name'
    const credit = author?.name === undefined ? '' : `, ${author.name}${author.url === undefined ? '' : ` (${author.url})`}`

    return [`kay: ${name} (@iconify-json/${prefix}) comes under ${terms}, which may ask more than the notice in ${NOTICES_FILE}, such as crediting their author${credit} where they show${license?.url === undefined ? '' : `: read ${license.url}`}`]
  })
}

// The text of a notices file: each package by name and version with its licence, packages sharing one licence text listed together above it.
export function thirdPartyNotices(packages: Iterable<string>): string {
  const groups = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const dir of packages) {
    const real = existsSync(dir) ? realpathSync(dir) : undefined

    if (real === undefined || seen.has(real))
      continue

    seen.add(real)

    const manifest = readJson<PackageJson>(join(real, 'package.json'))

    if (manifest?.name === undefined)
      continue

    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'no licence named'
    const files = readdirSync(real).filter(file => LICENSE_FILE.test(file)).sort()
    const text = files.map(file => readFileSync(join(real, file), 'utf8').trim()).join('\n\n')
    const icons = manifest.name.startsWith('@iconify-json/') ? iconSetInfo(real) : undefined
    const lines = [`${[manifest.name, manifest.version].filter(Boolean).join(' ')} (${license})`]

    if (icons?.name !== undefined)
      lines.push(`  ${icons.name}${icons.author?.name === undefined ? '' : ` by ${icons.author.name}`}${icons.author?.url === undefined ? '' : `, ${icons.author.url}`}${icons.license?.url === undefined ? '' : `, licence at ${icons.license.url}`}`)

    const key = text === '' ? `Its package holds no licence file; it comes under ${license}.` : text

    groups.set(key, [...groups.get(key) ?? [], lines.join('\n')])
  }

  const sections = [...groups].map(([text, names]) => [...names.sort(), '', text].join('\n')).sort()

  return [`Third-party software this build carries, each under the licence that follows its name.`, ...sections].join(`\n\n${RULE}\n\n`).concat('\n')
}
