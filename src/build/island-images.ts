import type { CheckDiagnostic } from '../check'
import type { NamedAttribute } from '../compiler/ast'
import type { LintLevels } from '../compiler/lints'
import type { ImageOptions } from '../runtime/image'
import type { ClientOptions } from './client'
import type { ImportGraph, KayLibrary } from './libraries'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { walkNodes } from '../compiler/ast'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { image, registerImage } from '../runtime/image'
import { imageHeader } from '../server/image-format'
import { ASSET_PREFIX, ASSETS_DIR } from './assets'
import { importEdges, reachedFrom } from './libraries'

// What the browser of a static export draws that no page rendered: an island's `img` or `image()` of an image the build cannot see otherwise, so no file would be written for its crop, its quality or its small width.
// Read from the sources of the components an island reaches, as `iconSlotsOf` reads icon slots; a value that is no literal is not known here.
export interface IslandImage {
  // The imported file, which the build names its asset after.
  file: string
  options: ImageOptions
}

// An `image(url, { width, height, ... })` of an image on another host, its URL a literal.
export interface RemoteIslandImage extends Position {
  src: string
  options: ImageOptions
}

interface Position {
  file: string
  line: number
  column: number
}

// An image of an island that a static export cannot write files for, and why: its source is neither an import nor a literal (a remote image the build cannot fetch), its size is no number literal, or its crop, quality or sizes is no literal.
export interface DynamicIslandImage extends Position {
  reason: 'source' | 'size' | 'option'
}

export interface IslandImages {
  imported: IslandImage[]
  remote: RemoteIslandImage[]
  dynamic: DynamicIslandImage[]
}

const IMAGE_IMPORT = /^import\s+(\w+)\s+from\s+(["'])(\.[^"'\n]*\.(?:png|jpe?g|webp|gif|avif))\2/gm
const KAY_IMAGE_IMPORT = /import\s*\{[^}]*\bimage\b[^}]*\}\s*from\s*["']kay\/image["']/
const IMAGE_CALL = /(?<![\w$])(?<!(?<!\.\.)\.)image\(\s*(?:(["'])(https?:\/\/[^"'\n]+)\1|([\w$.]+)\s*(?=[,)]))\s*(?:,\s*\{((?:[^{}]|\$\{[^}]*\})*)\})?/g
const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
const STRING = /^(["'`])(.*)\1$/s
const SCANNED = /\.(?:kay|[cm]?[jt]sx?)$/
const REMOTE = /^https?:\/\//i

// A literal as written, a number or a string; undefined for anything computed.
function literal(text: string): string | number | undefined {
  const written = text.trim()

  if (NUMBER.test(written))
    return Number(written)

  const inner = STRING.exec(written)?.[2]

  // A template literal is read when nothing is interpolated.
  return written.startsWith('`') && inner?.includes('${') === true ? undefined : inner
}

function optionsOf(read: (name: string) => string | undefined): ImageOptions {
  const sizes = literal(read('sizes') ?? '')
  const aspect = literal(read('aspect') ?? '')
  const quality = literal(read('quality') ?? '')
  const width = literal(read('width') ?? '')
  const height = literal(read('height') ?? '')

  return {
    ...typeof sizes === 'string' && { sizes },
    ...typeof aspect === 'string' && { aspect },
    ...typeof quality === 'number' && { quality },
    ...typeof width === 'number' && { width },
    ...typeof height === 'number' && { height },
  }
}

// The options `read` finds written but `optionsOf` could not take, as a value computed.
function unreadOptions(read: (name: string) => string | undefined): boolean {
  const options = optionsOf(read)

  return (['sizes', 'aspect', 'quality'] as const).some(name => read(name) !== undefined && options[name] === undefined)
}

function fieldOf(text: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|[,{\\s])${name}(?:\\s*:\\s*("[^"]*"|'[^']*'|\x60[^\x60]*\x60|[^,}\\s]+)|(?=\\s*(?:[,}]|$)))`).exec(text)

  // A shorthand property holds a variable, written by its name.
  return found === null ? undefined : found[1] ?? name
}

// The files the sources import by identifier, as absolute paths.
function importedImages(source: string, file: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const [, name, , path] of source.matchAll(IMAGE_IMPORT))
    found.set(name!, resolve(dirname(file), path!))

  return found
}

// What the `.kay` and script files hand the browser to draw, an image option written: a bare `img` of an imported image gives nothing new unless it asks for a crop, a quality or a width.
export function scanIslandImages(files: Iterable<string>): IslandImages {
  const found: IslandImages = { imported: [], remote: [], dynamic: [] }

  for (const file of files) {
    if (!SCANNED.test(file))
      continue

    let source: string

    try {
      source = readFileSync(file, 'utf8')
    }
    catch {
      continue
    }

    if (!source.includes('img') && !source.includes('image('))
      continue

    const imports = importedImages(source, file)

    if (file.endsWith('.kay')) {
      walkNodes(parseKay(source).template, undefined, (node) => {
        if (node.kind !== 'element' || node.component || node.name !== 'img')
          return undefined

        const named = (name: string) => node.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && attribute.kind !== 'boolean' && source.slice(attribute.name.start, attribute.name.end) === name)
        const value = (name: string) => {
          const attribute = named(name)

          if (attribute?.kind === 'static')
            return JSON.stringify(attribute.text)

          return attribute?.kind === 'expression' ? source.slice(attribute.expression.start, attribute.expression.end) : undefined
        }
        const src = value('src')?.trim()
        const options = optionsOf(value)
        const imported = src === undefined ? undefined : imports.get(src)

        if (imported !== undefined && (options.aspect !== undefined || options.quality !== undefined || options.sizes !== undefined))
          found.imported.push({ file: imported, options })

        if (imported !== undefined && unreadOptions(value))
          found.dynamic.push({ file, ...positionAt(source, node.start), reason: 'option' })

        return undefined
      })
    }

    if (!KAY_IMAGE_IMPORT.test(source))
      continue

    for (const match of source.matchAll(IMAGE_CALL)) {
      const [, , url, name, written] = match
      const options = optionsOf(field => written === undefined ? undefined : fieldOf(written, field))

      const at = { file, ...positionAt(source, match.index) }
      const read = (field: string) => written === undefined ? undefined : fieldOf(written, field)
      const sized = options.width !== undefined && options.height !== undefined

      if (url !== undefined && sized)
        found.remote.push({ src: url, options, ...at })
      else if (url !== undefined)
        found.dynamic.push({ ...at, reason: 'size' })
      else if (imports.has(name!))
        found.imported.push({ file: imports.get(name!)!, options })
      else if (url === undefined && read('width') !== undefined && read('height') !== undefined)
        found.dynamic.push({ ...at, reason: 'source' })

      if ((url !== undefined || imports.has(name!)) && unreadOptions(read))
        found.dynamic.push({ ...at, reason: 'option' })
    }
  }

  return found
}

// The name the build gives an imported file in `assets`: its content's hash after its own name.
export function assetNameOf(file: string): string | undefined {
  try {
    const extension = extname(file)

    return `${basename(file, extension)}-${Bun.hash(readFileSync(file)).toString(36)}${extension}`
  }
  catch {
    return undefined
  }
}

// The URL `registerImage` knows an imported file by.
export function assetUrlOf(file: string): string | undefined {
  const name = assetNameOf(file)

  return name === undefined ? undefined : `${ASSET_PREFIX}${ASSETS_DIR}/${encodeURIComponent(name)}`
}

// What the islands of a static export draw that no page renders, and the options its browser bundle is built with: it links a remote image as a file only when the build fetches it, a literal URL given its size on a host `images.remote` lists.
// `ClientOptions.staticImages` is the hosts `images.remote` lists, and what this adds: the remote URLs the build fetches.
export async function exportedImages(root: string, sources: { islands: Map<string, string>, libraries: KayLibrary[] }, graph: ImportGraph, options: ClientOptions): Promise<{ images: IslandImages | undefined, bundled: ClientOptions }> {
  if (options.exported !== true)
    return { images: undefined, bundled: options }

  const images = scanIslandImages(await reachedFrom([...sources.islands.values()], importEdges(root, sources.libraries, graph)))

  const { staticImages } = options

  return { images, bundled: staticImages ? { ...options, staticImages: { ...staticImages, remote: linkedRemote(images, staticImages.allowed).map(({ src }) => src) } } : options }
}

// The value of `KAY_STATIC_REMOTE` in the browser bundle.
export function staticRemoteDefine({ staticImages }: ClientOptions): string {
  return staticImages?.remote === undefined ? 'undefined' : JSON.stringify(staticImages.remote)
}

// The remote images a static export writes files for: a literal URL given its size, on a host `images.remote` lists.
export function linkedRemote(images: IslandImages, allowed: (src: string) => boolean): RemoteIslandImage[] {
  return images.remote.filter(({ src }) => REMOTE.test(src) && allowed(src))
}

// Asks the image runtime for the variants the islands draw, which records the ones beyond the ladder for the build to write: the images are registered first, as a server that never loaded the island's module has not.
// Returns what `kay check` says of the ones it cannot read, when `checking`.
export async function recordIslandImages(clientDir: string, images: IslandImages | undefined, allowed: (src: string) => boolean, { checking, lints }: { checking: boolean, lints: LintLevels | undefined }): Promise<CheckDiagnostic[]> {
  if (images === undefined)
    return []

  for (const { file, options } of images.imported) {
    const name = assetNameOf(file)
    const path = name === undefined ? undefined : join(clientDir, ASSETS_DIR, name)

    if (path === undefined || !existsSync(path))
      continue

    // An image kay cannot decode is served as it is, with no variants.
    let header: Awaited<ReturnType<typeof imageHeader>>

    try {
      header = await imageHeader(Bun.file(path))
    }
    catch {
      continue
    }

    if (!header.animated)
      image(registerImage(assetUrlOf(file)!, header.width, header.height), options)
  }

  for (const { src, options } of linkedRemote(images, allowed))
    image(src, options)

  const level = lintLevel('static-remote-image', lints)

  return checking && level !== 'allow' ? dynamicImageLints(images, level, allowed) : []
}

const UNREAD = {
  source: { message: 'This `image()` of an island takes a source the build cannot read, so a static export, which has no image route, links the original image instead of resized files', help: 'give `image()` the image\'s URL as a literal in the island, on a host `images.remote` lists, so the build fetches and resizes it, or draw the image where the server renders it' },
  size: { message: 'This `image()` of an island takes a width or a height that is no number literal, so the build cannot fetch and resize the image and a static export links the original', help: 'write the width and the height as numbers' },
  option: { message: 'This island image takes a crop, a quality or sizes that is no literal, so a static export, which writes the files it reads from the source, has none for it and the browser asks for a file that does not exist', help: 'write `aspect`, `quality` and `sizes` as literals in the island' },
  host: { message: 'This `image()` URL is on a host `images.remote` does not list, so a static export links the original image instead of resized files', help: 'list the host in `images.remote`, so the build fetches and resizes it' },
} as const

// What `kay check` says of the island images a static export cannot write files for: they keep their own URL, or ask the browser for a file that is not there.
export function dynamicImageLints(images: IslandImages, level: 'warn' | 'deny', allowed: (src: string) => boolean = () => true): CheckDiagnostic[] {
  const unlisted = images.remote.filter(({ src }) => !allowed(src)).map(({ file, line, column }) => ({ file, line, column, reason: 'host' as const }))

  return [...images.dynamic, ...unlisted].map(({ file, line, column, reason }) => ({ file, line, column, code: 'static-remote-image', severity: level === 'warn' ? 'warning' : 'error', ...UNREAD[reason] }))
}
