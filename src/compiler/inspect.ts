import type { ElementNode } from './ast'

// The document's own elements and the head's, which no click reaches.
const UNINSPECTED = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'style', 'base', 'noscript', 'template', 'slot'])

// What `data-kay-src` holds for each element of one file in development, for `kay dev`'s inspector: its path from the root, then the line and column of its tag.
export function sourceLocator(source: string, file: string, real: (offset: number) => number = offset => offset): (element: ElementNode) => string | undefined {
  const lineStarts = [0]

  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1))
    lineStarts.push(i + 1)

  return (element) => {
    if (UNINSPECTED.has(element.name))
      return undefined

    const start = real(element.start)
    let low = 0
    let high = lineStarts.length - 1

    while (low < high) {
      const middle = (low + high + 1) >> 1

      if (lineStarts[middle]! <= start)
        low = middle
      else
        high = middle - 1
    }

    return `${file}:${low + 1}:${start - lineStarts[low]! + 1}`
  }
}
