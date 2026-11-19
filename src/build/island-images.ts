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
export interface RemoteIslandImage {
  src: string
  options: ImageOptions
}

// An `image()` whose source is neither an import nor a literal, written with a size, so a remote image: a static export cannot resize it in the browser.
export interface DynamicIslandImage {
  file: string
  line: number
  column: number
}

export interface IslandImages {
  imported: IslandImage[]
  remote: RemoteIslandImage[]
  dynamic: DynamicIslandImage[]
}

const IMAGE_IMPORT = /^import\s+(\w+)\s+from\s+(["'])(\.[^"'\n]*\.(?:png|jpe?g|webp|gif|avif))\2/gm
const KAY_IMAGE_IMPORT = /import\s*\{[^}]*\bimage\b[^}]*\}\s*from\s*["']kay\/image["']/
const IMAGE_CALL = /\bimage\(\s*(?:(["'])(https?:\/\/[^"'\n]+)\1|([\w$.]+)\s*(?=[,)]))\s*(?:,\s*\{([^{}]*)\})?/g
const NUMBER = /^\d+(?:\.\d+)?$/
const STRING = /^(["'])(.*)\1$/s
const SCANNED = /\.(?:kay|[cm]?[jt]sx?)$/
const REMOTE = /^https?:\/\//i

// A literal as written, a number or a string; undefined for anything computed.
function literal(text: string): string | number | undefined {
  const written = text.trim()

  return NUMBER.test(written) ? Number(written) : STRING.exec(written)?.[2]
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

function fieldOf(text: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|[,{\\s])${name}(?:\\s*:\\s*("[^"]*"|'[^']*'|[^,}\\s]+)|(?=\\s*(?:[,}]|$)))`).exec(text)

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

        return undefined
      })
    }

    if (!KAY_IMAGE_IMPORT.test(source))
      continue

    for (const match of source.matchAll(IMAGE_CALL)) {
      const [, , url, name, written] = match
      const options = optionsOf(field => written === undefined ? undefined : fieldOf(written, field))

      if (url !== undefined) {
        if (options.width !== undefined && options.height !== undefined)
          found.remote.push({ src: url, options })
      }
      else if (imports.has(name!)) {
        found.imported.push({ file: imports.get(name!)!, options })
      }
      else if (written !== undefined && fieldOf(written, 'width') !== undefined && fieldOf(written, 'height') !== undefined) {
        found.dynamic.push({ file, ...positionAt(source, match.index) })
      }
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

  return checking && level !== 'allow' ? dynamicImageLints(images, level) : []
}

// The `image()` calls of an island on a source that is no import and no literal, drawn with a size: on a static export they link the original, as the build cannot know which images to fetch.
export function dynamicImageLints(images: IslandImages, level: 'warn' | 'deny'): CheckDiagnostic[] {
  return images.dynamic.map(({ file, line, column }) => ({ file, line, column, code: 'static-remote-image', severity: level === 'warn' ? 'warning' : 'error', message: 'This `image()` of an island takes a source the build cannot read, so a static export, which has no image route, links the original image instead of resized files', help: 'give `image()` the image\'s URL as a literal in the island, on a host `images.remote` lists, so the build fetches and resizes it, or draw the image where the server renders it' }))
}
