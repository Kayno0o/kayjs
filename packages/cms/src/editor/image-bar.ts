import type { ImageBar } from './page-images'
import { entryKey } from '../markers'

// Whether two bars show the same button in the same place, so a write of one over the other changes nothing.
export function sameBar(left: ImageBar | undefined, right: ImageBar | undefined): boolean {
  if (!left || !right)
    return left === right

  return left.style === right.style && left.path === right.path && left.accept === right.accept && left.label === right.label && entryKey(left.entry) === entryKey(right.entry)
}
