import type { Stats } from 'node:fs'
// Relative images in a Markdown body: linked to the built assets when the entry compiles, and given their srcset and sizes when it renders, as `image()` gives an imported one.
import type { Segment } from './markdown'
import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { writeAsset } from '../build/assets'
import { escapeAttribute } from '../runtime/escape'
import { image, RESIZABLE } from '../runtime/image'
import { imageHeader } from '../server/image-format'

// An image a body links, as the entry's cache keeps it: the file, relative to the project root, and the URL it was built to, which a changed file renames.
export interface LinkedImage {
  file: string
  url: string
  // The file's time and size when it was linked, which stand in for hashing it while they hold.
  stamp?: string | undefined
}

// What a body names that cannot be linked yet: files that are not there, and files that are but do not read as an image, with the time and size they had, so a copy that finishes is noticed.
export interface Unlinked {
  missing: Set<string>
  unreadable: Map<string, string>
}

const IMG_TAG = /<img\b[^>]*>/gi
const SRC = /(\ssrc=")([^"]*)(")/i
const SIZED = /\s(?:width|height|srcset)\s*=/i
const SIZES_ATTRIBUTE = /\ssizes\s*=/i
// An author's `sizes` kay reads: double-quoted, as the attribute is nearly always written.
const OWN_SIZES = /\ssizes="([^"]*)"/i
const MARKER = / data-kay-image="(\d+)x(\d+)"/
const ANY_MARKER = / data-kay-image(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi
const BUILT = /^\/_kay\/assets\//
const SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/|#)/i
const QUERY_OR_HASH = /[?#].*$/
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#x27;': '\'' }
const ENTITY = /&(?:amp|lt|gt|quot|#39|#x27);/g

// The file's stat, or undefined when it is not there.
export async function statOf(file: string): Promise<Stats | undefined> {
  try {
    return await stat(file)
  }
  catch {
    return undefined
  }
}

function insideOf(dir: string, path: string): boolean {
  return path.startsWith(dir + sep)
}

// The built asset a relative `src` names, or undefined for a URL, an absolute path, a file outside the collection's folder, a missing one or one kay does not resize.
async function linkedImage(src: string, entryDir: string, folder: string, root: string, unlinked: Unlinked): Promise<{ file: string, url: string, stamp: string, width: number, height: number, animated: boolean } | undefined> {
  const decoded = src.replace(ENTITY, entity => ENTITIES[entity]!)

  if (decoded === '' || SCHEME.test(decoded) || decoded.includes('\0') || decoded.includes('\\'))
    return undefined

  let path: string

  try {
    path = decodeURIComponent(decoded.replace(QUERY_OR_HASH, ''))
  }
  catch {
    return undefined
  }

  if (!RESIZABLE.test(path))
    return undefined

  const file = resolve(entryDir, path)

  if (!insideOf(folder, file))
    return undefined

  try {
    // A link inside the folder to a file outside it is no image of the collection.
    if (!insideOf(realpathSync(folder), realpathSync(file)))
      return undefined

    const { width, height, animated } = await imageHeader(Bun.file(file))
    const { mtimeMs, size } = await stat(file)

    return { file, url: await writeAsset(file, root), stamp: `${mtimeMs}:${size}`, width, height, animated }
  }
  catch {
    // A file not there yet, or half copied, is linked once it is, which the entry's cache looks for.
    if (!file.includes('\0')) {
      const found = await statOf(file)

      if (found === undefined)
        unlinked.missing.add(file)
      else if (found.isFile())
        unlinked.unreadable.set(file, `${found.mtimeMs}:${found.size}`)
    }

    return undefined
  }
}

// The segments with each relative image of their HTML pointed at its built asset, and marked with its size for `sizedImages` when it can be resized; the images linked, for the entry's cache.
export async function linkImages(segments: Segment[], entryFile: string, folder: string, root: string): Promise<{ segments: Segment[], images: LinkedImage[], missing: string[], unreadable: { file: string, stamp: string }[] }> {
  const images = new Map<string, LinkedImage>()
  const unlinked: Unlinked = { missing: new Set(), unreadable: new Map() }
  const entryDir = dirname(entryFile)

  const link = async (html: string): Promise<string> => {
    let out = ''
    let last = 0

    for (const match of html.matchAll(IMG_TAG)) {
      // A marker the author wrote is no size kay read.
      const tag = match[0].replace(ANY_MARKER, '')
      const src = SRC.exec(tag)

      if (!src) {
        if (tag !== match[0]) {
          out += html.slice(last, match.index) + tag
          last = match.index + match[0].length
        }

        continue
      }

      const linked = await linkedImage(src[2]!, entryDir, folder, root, unlinked)

      if (!linked) {
        if (tag !== match[0]) {
          out += html.slice(last, match.index) + tag
          last = match.index + match[0].length
        }

        continue
      }

      images.set(linked.file, { file: linked.file, url: linked.url, stamp: linked.stamp })

      const marked = linked.animated || SIZED.test(tag) || (SIZES_ATTRIBUTE.test(tag) && !OWN_SIZES.test(tag)) ? '' : ` data-kay-image="${linked.width}x${linked.height}"`
      const rewritten = tag.replace(SRC, (_, start: string, __, end: string) => `${start}${escapeAttribute(linked.url)}${end}${marked}`)

      out += html.slice(last, match.index) + rewritten
      last = match.index + match[0].length
    }

    return out + html.slice(last)
  }

  const walk = async (list: Segment[]): Promise<Segment[]> => {
    const result: Segment[] = []

    for (const segment of list)
      result.push(typeof segment === 'string' ? await link(segment) : { ...segment, children: await walk(segment.children) })

    return result
  }

  const linked = await walk(segments)

  return { segments: linked, images: [...images.values()], missing: [...unlinked.missing], unreadable: [...unlinked.unreadable].map(([file, stamp]) => ({ file, stamp })) }
}

// The HTML with each image `linkImages` marked given the `srcset`, `sizes`, `width` and `height` `image()` gives, so it loads the width its screen needs.
export function sizedImages(html: string, sizes = '100vw'): string {
  if (!html.includes('data-kay-image'))
    return html

  return html.replace(IMG_TAG, (tag) => {
    const size = MARKER.exec(tag)
    const src = SRC.exec(tag)

    if (!size || !src || !BUILT.test(src[2]!))
      return tag

    const own = OWN_SIZES.exec(tag)
    const props = image(src[2]!.replace(ENTITY, entity => ENTITIES[entity]!), { width: Number(size[1]), height: Number(size[2]), sizes: own ? own[1]!.replace(ENTITY, entity => ENTITIES[entity]!) : sizes })

    if (props.srcset === undefined)
      return tag.replace(MARKER, '')

    return tag
      .replace(MARKER, '')
      .replace(OWN_SIZES, '')
      .replace(SRC, (_, start: string, __, end: string) => `${start}${escapeAttribute(props.src)}${end} srcset="${escapeAttribute(props.srcset!)}" sizes="${escapeAttribute(props.sizes!)}" width="${props.width}" height="${props.height}"`)
  })
}
