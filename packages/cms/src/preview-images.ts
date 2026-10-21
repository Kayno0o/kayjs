import { realpath } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { withBase } from 'kay'
import { repositoryRoot } from 'kay/content'
import { entryFile } from './kay/content'
import { collectionNamed } from './store'

// What the preview serves from a collection's folder: the image types kay builds, never an SVG, which can run script.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

const IMG_SRC = /(<img\b[^>]*?\ssrc=")([^"]*)(")/g
// A URL with a scheme, a protocol-relative one, a path from the site's root or a fragment is no path in the collection's folder.
const NOT_RELATIVE = /^(?:[a-z][a-z\d+.-]*:|\/|#|$)/i
const AMPERSAND = /&/g
const QUERY_OR_FRAGMENT = /[?#].*$/

export interface EntryPlace {
  collection: string
  slug: string
  locale?: string | undefined
}

// Points each image of the preview written as a path in the collection's folder, such as `./cat.png`, at the route that reads it from there.
export function imagesFromFolder(html: string, place: EntryPlace): string {
  return html.replace(IMG_SRC, (whole, before: string, src: string, after: string) => {
    if (NOT_RELATIVE.test(src))
      return whole

    let path: string

    try {
      path = decodeURIComponent(src.replace(QUERY_OR_FRAGMENT, ''))
    }
    catch {
      return whole
    }

    const query = new URLSearchParams({ collection: place.collection, slug: place.slug, path })

    if (place.locale !== undefined)
      query.set('locale', place.locale)

    return `${before}${withBase('/api/cms/markdown/image')}?${query.toString().replace(AMPERSAND, '&amp;')}${after}`
  })
}

// The image file a relative path names for an entry, read from the entry's own folder and never from outside the collection's: undefined for a path that leaves it (a `..` or a symlink), names no file or is no image type.
export async function folderImage(place: EntryPlace, path: string): Promise<{ file: string, type: string } | undefined> {
  const type = IMAGE_TYPES[extname(path).toLowerCase()]
  const { dir } = await collectionNamed(place.collection)

  if (type === undefined || dir === undefined)
    return undefined

  const root = resolve(repositoryRoot(), dir)
  const found = await entryFile(place.collection, place.slug, place.locale === undefined ? {} : { locale: place.locale })

  try {
    const [inside, folder] = await Promise.all([realpath(root), realpath(resolve('file' in found && found.file.repoPath.startsWith(`${dir}/`) ? dirname(resolve(root, found.file.repoPath.slice(dir.length + 1))) : root, path))])

    return folder.startsWith(inside + sep) ? { file: folder, type } : undefined
  }
  catch {
    return undefined
  }
}
