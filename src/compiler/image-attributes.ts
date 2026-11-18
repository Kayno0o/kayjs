import type { Attribute, ElementNode, NamedAttribute, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { decodeEntities } from './expression'

type WrittenAttribute = Extract<NamedAttribute, { kind: 'static' | 'expression' }>
type Source = (span: Span) => string

// An image loads lazily and decodes off the main thread unless the template says otherwise: a hero above the fold sets `loading="eager"` or `fetchpriority="high"`.
export function imageDefaults(element: ElementNode, named: (name: string) => boolean): [string, string][] {
  if (element.name !== 'img')
    return []

  const defaults: [string, string][] = []

  if (!named('loading') && !named('fetchpriority'))
    defaults.push(['loading', 'lazy'])

  if (!named('decoding'))
    defaults.push(['decoding', 'async'])

  return defaults
}

export interface ImageOptionAttributes {
  aspect: WrittenAttribute | undefined
  quality: WrittenAttribute | undefined
  placeholder: WrittenAttribute | undefined
}

// What an `img` with an imported `src` takes beside `sizes`, `width` and `height`: the shape it is cut to, the quality of its variants, and whether it shows its color until it loads. Read by the source and never written.
export const IMAGE_OPTIONS = new Set(['aspect', 'quality', 'placeholder'])

// The attributes an `img` with an imported `src` takes besides `sizes`, and whether it shows its color until it loads.
export function imageOptions(element: ElementNode, source: Source): { options: ImageOptionAttributes, colour: boolean } {
  const find = (name: string) => element.attributes.find((attribute): attribute is WrittenAttribute => attribute.kind !== 'spread' && attribute.kind !== 'boolean' && source(attribute.name) === name)
  const options = { aspect: find('aspect'), quality: find('quality'), placeholder: find('placeholder') }
  const written = (name: string) => element.attributes.some(attribute => attribute.kind !== 'spread' && source(attribute.name) === name)

  return { options, colour: !written('style') && !placeholderOff(options.placeholder, source) }
}

// Whether the attribute is `placeholder={false}`, the one form kay reads while compiling, so the server leaves the color out.
export function placeholderOff(attribute: Attribute | undefined, source: Source): boolean {
  return attribute?.kind === 'expression' && source(attribute.expression).trim() === 'false'
}

// The arguments of `imageAttributes` and `KayImage` after `sized`: `sizes`, the color left out (the server's only), the shape and the quality, up to the last one written.
export function writeImageArguments(b: CodeBuilder, sizes: NamedAttribute | undefined, options: ImageOptionAttributes, colour: boolean, server: boolean): void {
  const value = (given: NamedAttribute | undefined) => {
    if (given?.kind === 'static')
      return () => void b.add(JSON.stringify(decodeEntities(given.text)))

    return given?.kind === 'expression' ? () => void b.add('(').addSource(given.expression).add(')') : undefined
  }
  const { aspect, quality, placeholder } = options
  const slots = server ? [value(sizes), colour ? value(placeholder) : () => void b.add('false'), value(aspect), value(quality)] : [value(sizes), value(aspect), value(quality)]
  const last = slots.findLastIndex(slot => slot !== undefined)

  for (const slot of slots.slice(0, last + 1)) {
    b.add(', ')

    if (slot)
      slot()
    else
      b.add('undefined')
  }
}
