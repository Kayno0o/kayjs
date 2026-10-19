import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { scoped } from './files'
import { installedIconSets } from './icons'

// Written beside the browser build, so it reaches every host serving `/_kay/`, and carried by an executable for `--licenses`.
export const NOTICES_FILE = 'THIRD-PARTY-LICENSES.txt'

const NODE_MODULES = `${sep}node_modules${sep}`
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][\w.-]*)?$/i
// What asks nothing more than its notice kept with the copy, which the notices file is; an icon set under anything else is warned about.
const NOTICE_ENOUGH = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Unlicense', 'OFL-1.1', 'MPL-2.0'])
const LICENSES_DIR = 'LICENSES'
const RULE = '='.repeat(80)
const MIT_TERMS = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'

// The standard MIT text under a holder's copyright line, for an icon set whose package ships none.
function mitText(holder: string): string {
  return `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_TERMS}`
}

// What an executable carries that no package of the project holds: the Bun runtime it embeds, which statically links JavaScriptCore and WebCore under the LGPL-2.
// The source of those libraries and a way to link a changed copy are what the LGPL asks to be offered.
function bunNotice(version: string): string {
  return [
    `Bun ${version} (MIT), the runtime this executable embeds`,
    '',
    'Bun is under the MIT licence, https://github.com/oven-sh/bun/blob/main/LICENSE.md, which also lists the licences of what it links.',
    'It statically links JavaScriptCore and the WebCore files of WebKit, which are under the GNU Lesser General Public License, version 2 (https://www.gnu.org/licenses/old-licenses/lgpl-2.0.txt).',
    'The source Bun builds them from is the oven-sh/webkit repository, https://github.com/oven-sh/webkit, and the source of Bun itself is https://github.com/oven-sh/bun.',
    'To replace the LGPL parts with a modified copy: get both repositories at the revisions of this Bun version, change JavaScriptCore or WebCore as the LGPL allows, build Bun from them as its contributing guide, https://bun.sh/docs/project/contributing, describes, then build this application with that Bun: `bun build --compile` on its source gives an executable linked with your copy.',
  ].join('\n')
}

// What a package's wasm compiles in, whose licences its own files do not carry: keyed by package and exact version, as a bump may change the codecs, and a test fails when the installed version leaves the map.
// @jsquash/avif 2.1.1: packages/avif/codec/Makefile of jSquash (https://github.com/jamsinclair/jSquash/blob/da47a2be3b302beb5a5ae164a2ab7aa21a041d90/packages/avif/codec/Makefile, a commit of its main, as it has no tags) builds its decoder, the one wasm of it kay ships, from libavif v1.0.1 with libaom v3.7.0, and holds the string "AOMedia Project AV1 Decoder v3.7.0". kay's own encoder (codecs/avif) is kay's code: its codecs' texts are in kay's LICENSES/ and NOTICE.
// The texts are those of each repository at that tag or commit. Emscripten 3.1.57 (the build script's EMSDK_VERSION) generates the glue and links musl into the wasm; their texts are those of that tag. compiler-rt is left out: its LLVM exception frees code embedded in object form from the attribution conditions.
export const BUNDLED_LICENCES: Record<string, Record<string, { codec: string, files: string[] }[]>> = {
  '@jsquash/avif': {
    '2.1.1': [
      { codec: 'libavif 1.0.1 (BSD-2-Clause), https://github.com/AOMediaCodec/libavif/blob/v1.0.1/LICENSE', files: ['libavif.txt'] },
      { codec: 'libaom 3.7.0 (BSD-2-Clause and the AOMedia Patent License 1.0), https://aomedia.googlesource.com/aom/+/refs/tags/v3.7.0', files: ['libaom.txt', 'libaom-PATENTS.txt'] },
      { codec: 'Emscripten 3.1.57 (MIT and NCSA), the glue and runtime, https://github.com/emscripten-core/emscripten/blob/3.1.57/LICENSE', files: ['emscripten.txt'] },
      { codec: 'musl, linked in by Emscripten 3.1.57 (MIT), https://github.com/emscripten-core/emscripten/blob/3.1.57/system/lib/libc/musl/COPYRIGHT', files: ['musl.txt'] },
    ],
  },
}

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
  return scoped(`dependencies ${root}`, () => readInstalledDependencies(root))
}

function readInstalledDependencies(root: string): string[] {
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

// The package's licence files, those under a REUSE-style `LICENSES/` included; a directory or an unreadable file under such a name is skipped.
function licenceTexts(dir: string): string {
  const files = [...readdirSync(dir).filter(file => LICENSE_FILE.test(file)).sort(), ...existsSync(join(dir, LICENSES_DIR)) ? readdirSync(join(dir, LICENSES_DIR)).sort().map(file => join(LICENSES_DIR, file)) : []]

  return files.flatMap((file) => {
    try {
      return statSync(join(dir, file), { throwIfNoEntry: false })?.isFile() === true ? [readFileSync(join(dir, file), 'utf8').trim()] : []
    }
    catch {
      return []
    }
  }).join('\n\n')
}

const BUNDLED_DIR = join(import.meta.dir, '..', '..', LICENSES_DIR)

// The packages among `dirs` that kay knows codecs for, installed at a version it holds no texts for.
export function unknownCodecVersions(dirs: Iterable<string>): string[] {
  return [...dirs].flatMap((dir) => {
    const { name, version } = readJson<PackageJson>(join(dir, 'package.json')) ?? {}

    return name !== undefined && name in BUNDLED_LICENCES && (version === undefined || BUNDLED_LICENCES[name]![version] === undefined) ? [`${name}@${version}`] : []
  })
}

// One line per installed package whose codecs kay holds no licence texts for, so its notices would lack them.
export function codecWarnings(root: string): string[] {
  return unknownCodecVersions(installedDependencies(root)).map(spec => `kay: ${spec} is a version kay holds no codec licence texts for, so ${NOTICES_FILE} lacks the licences of the codecs its wasm compiles in; add the texts for that version to BUNDLED_LICENCES in src/build/licenses.ts and to LICENSES/`)
}

function bundledTexts(name: string, version: string | undefined): string[] {
  return (version === undefined ? undefined : BUNDLED_LICENCES[name]?.[version])?.map(({ codec, files }) => [`Compiled into it: ${codec}`, ...files.map(file => readFileSync(join(BUNDLED_DIR, file), 'utf8').trim())].join('\n\n')) ?? []
}

// What stands for the licence text of a package that ships none: the standard MIT text for an icon set under it, naming its author, else a line saying so.
function unwrittenLicence(license: string, name: string, icons: IconSetInfo | undefined): string {
  if (icons?.license?.spdx === 'MIT' && icons.author?.name !== undefined)
    return `Its package holds no licence file; this is the MIT licence it comes under, as ${icons.name ?? name} states it.\n\n${mitText(icons.author.name)}`

  return `Its package holds no licence file; it comes under ${license}.`
}

// The text of a notices file: each package by name and version with its licence, packages sharing one licence text listed together above it.
export function thirdPartyNotices(packages: Iterable<string>, options: { executable?: boolean } = {}): string {
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
    const text = [licenceTexts(real), ...bundledTexts(manifest.name, manifest.version)].filter(part => part !== '').join('\n\n')
    const icons = manifest.name.startsWith('@iconify-json/') ? iconSetInfo(real) : undefined
    const lines = [`${[manifest.name, manifest.version].filter(Boolean).join(' ')} (${license})`]

    if (icons?.name !== undefined)
      lines.push(`  ${icons.name}${icons.author?.name === undefined ? '' : ` by ${icons.author.name}`}${icons.author?.url === undefined ? '' : `, ${icons.author.url}`}${icons.license?.url === undefined ? '' : `, licence at ${icons.license.url}`}`)

    // An icon set under the MIT licence that ships no text: the standard text, with the copyright line its metadata gives.
    const key = text === '' ? unwrittenLicence(license, manifest.name, icons) : text

    groups.set(key, [...groups.get(key) ?? [], lines.join('\n')])
  }

  const sections = [...[...groups].map(([text, names]) => [...names.sort(), '', text].join('\n')).sort(), ...options.executable ? [bunNotice(Bun.version)] : []]

  return [`Third-party software this build carries, each under the licence that follows its name.`, ...sections].join(`\n\n${RULE}\n\n`).concat('\n')
}
