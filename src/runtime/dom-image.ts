import { attribute } from './dom'
import { imageSource } from './image'

// What `img(src={hero})` sets, its size left alone when the template gives one.
const IMAGE_SOURCE = ['src', 'srcset', 'sizes']
const SIZED_IMAGE = ['src', 'srcset', 'sizes', 'width', 'height']

// An `img` source, with the variants, `sizes` and size of an imported image; a later source clears what an earlier one set.
// Apart from `dom.ts`, as a bundle puts a module in the chunk its importers share, and the image runtime would weigh on every page.
export function image(element: Element, src: unknown, sized: boolean, sizes?: unknown): void {
  const props = imageSource(src, sized, sizes) as Record<string, unknown>

  for (const name of sized ? IMAGE_SOURCE : SIZED_IMAGE)
    attribute(element, name, props[name])
}
