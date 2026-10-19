import type { CheckDiagnostic, CheckOptions } from '.'
import type { NamedAttribute } from '../compiler/ast'
import type { ServedProject } from './shadow-types'
import { stat } from 'node:fs/promises'
import { findKayFiles } from '../build/files'
import { walkNodes } from '../compiler/ast'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

// Past this a raster is worth resizing: the image route serves the same picture as WebP at the width a page shows it, at most 2560 pixels, and a variant at 1280 pixels is seldom above 150 KiB.
export const LARGE_IMAGE_BYTES = 256 * 1024
const RASTER = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i
const QUERY_OR_HASH = /[?#].*$/

// The `img` of a template whose static `src` is a public raster over `LARGE_IMAGE_BYTES`, which is served as it is: the file is sent whole to every visitor, however small it is drawn.
// An `img` with its own `srcset` is left alone, as is a `src` written as an expression.
export async function largePublicImages(options: CheckOptions, root: string, { publicPaths }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('large-public-image', options.lints)

  if (level === 'allow')
    return []

  const rasters = publicPaths.filter(file => RASTER.test(file.url))
  const sizes = new Map<string, number>()

  await Promise.all(rasters.map(async file => sizes.set(file.url, (await stat(file.path)).size)))

  const large = new Map([...sizes].filter(([, size]) => size > LARGE_IMAGE_BYTES))

  if (large.size === 0)
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findKayFiles(root, { project: true, ownKayOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('img'))
      continue

    walkNodes(parseKay(source).template, undefined, (node) => {
      if (node.kind !== 'element' || node.component || node.name !== 'img')
        return undefined

      const named = (name: string) => node.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)
      const src = named('src')
      const url = src?.kind === 'static' ? src.text.replace(QUERY_OR_HASH, '') : undefined
      const size = url === undefined ? undefined : large.get(url)

      if (src === undefined || size === undefined || named('srcset'))
        return undefined

      found.push({
        file,
        ...positionAt(source, src.name.start),
        end: src.name.end,
        message: `\`${url}\` is ${Math.round(size / 1024)} KiB and public files are sent as they are, so every visitor downloads it whole`,
        help: 'move it into `src/` and import it, `import hero from \'./hero.jpg\'` then `img(src={hero})`, so kay serves it resized as WebP at the width the page shows it',
        code: 'large-public-image',
        severity: level === 'warn' ? 'warning' : 'error',
      })

      return undefined
    })
  }

  return found
}
