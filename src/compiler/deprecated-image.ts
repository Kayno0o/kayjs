import type { Details, ElementNode, Span } from './ast'

type Report = (span: Span, message: string, details: Details) => void

// `image(hero)` or `image(hero, { sizes: '100vw', aspect: '1/1' })`: a name or a member path, then an object written as `key: value` pairs.
const IMAGE_CALL = /^image\(\s*([\w$.]+)\s*(?:,\s*(?:\{([^{}]*)\}\s*(?:,\s*)?)?)?\)$/
const SIZED = /\b(?:width|height)\b/
// The options of `image()` an `img` takes as attributes since 1.105.
const OPTIONS = new Set(['sizes', 'aspect', 'quality', 'placeholder', 'width', 'height'])
const PAIR = /^([A-Z]+)\s*:\s*(\S[\s\S]*)$/i
const STRING_VALUE = /^(?:'([^'\\"{}]*)'|"([^'\\"{}]*)")$/

// The `key: value` pairs of an object body, split at the commas outside quotes, brackets and braces; undefined when a pair is not that shape.
function pairsOf(body: string): [string, string][] | undefined {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let from = 0

  for (let at = 0; at < body.length; at++) {
    const char = body[at]!

    if (quote !== '') {
      if (char === '\\')
        at++
      else if (char === quote)
        quote = ''
    }
    else if (char === '\'' || char === '"' || char === '`') {
      quote = char
    }
    else if ('([{'.includes(char)) {
      depth++
    }
    else if (')]}'.includes(char)) {
      depth--
    }
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(from, at))
      from = at + 1
    }
  }

  parts.push(body.slice(from))

  const pairs: [string, string][] = []

  for (const part of parts.map(each => each.trim()).filter(each => each !== '')) {
    const pair = PAIR.exec(part)

    if (!pair || !OPTIONS.has(pair[1]!))
      return undefined

    pairs.push([pair[1]!, pair[2]!.trim()])
  }

  return pairs
}

// The attribute an option becomes: a string as it is written, anything else as an expression.
function attributeOf(name: string, value: string): string {
  const text = STRING_VALUE.exec(value)

  return text ? `${name}="${text[1] ?? text[2]}"` : `${name}={${value}}`
}

// What an `img` wrote before 1.105 for the options of the image it shows: `no-placeholder` is `placeholder={false}`, and `{...image(hero, { aspect: '1/1' })}` is `src={hero} aspect="1/1"`.
export function deprecatedImage(element: ElementNode, text: (span: Span) => string, report: Report): void {
  const writes = (name: string) => element.attributes.some(attribute => attribute.kind !== 'spread' && text(attribute.name) === name)

  for (const attribute of element.attributes) {
    if (attribute.kind === 'boolean' && text(attribute.name) === 'no-placeholder') {
      report(attribute.name, '`no-placeholder` is `placeholder={false}` since 1.105, as every other option of an image is an attribute', writes('placeholder')
        ? { help: 'Drop `no-placeholder`, `placeholder` is there' }
        : { help: 'Write `placeholder={false}`', fixes: [{ title: 'Write `placeholder={false}`', edits: [{ start: attribute.name.start, end: attribute.name.end, text: 'placeholder={false}' }], safe: true }] })
    }

    if (attribute.kind !== 'spread')
      continue

    const written = text(attribute.expression).trim()
    const call = IMAGE_CALL.exec(written)

    if (!call) {
      if (written.startsWith('image(') && !SIZED.test(written))
        report(attribute.expression, '`image()` is for an element that is no `img` since 1.105: `img(src={hero} aspect="1/1")` takes its options as attributes', { help: 'Write the image as `src={hero}` with the options as attributes' })

      continue
    }

    const pairs = call[2] === undefined ? [] : pairsOf(call[2])

    // A size given to `image()` is for a source kay did not import, which an `img` leaves as it is: `image()` stays how those are written.
    if (pairs?.some(([name]) => name === 'width' || name === 'height'))
      continue

    const clash = pairs?.some(([name]) => writes(name)) === true || writes('src')
    const others = element.attributes.filter(other => other.kind === 'spread').length > 1
    const message = '`image()` is for an element that is no `img` since 1.105: `img(src={hero} aspect="1/1")` takes its options as attributes'

    if (!pairs || clash || others) {
      report(attribute.expression, message, { help: 'Write the image as `src={hero}` with the options as attributes' })

      continue
    }

    const attributes = [`src={${call[1]}}`, ...pairs.map(([name, value]) => attributeOf(name, value))]
    // The span of the whole `{ ...image(hero) }`: the expression has neither its braces nor its dots.
    const reach = 40
    const before = Math.max(0, attribute.expression.start - reach)
    const start = before + text({ start: before, end: attribute.expression.start }).lastIndexOf('{')
    const end = attribute.expression.end + text({ start: attribute.expression.end, end: attribute.expression.end + reach }).indexOf('}') + 1

    report(attribute.expression, message, { help: 'Write the image as `src={hero}` with the options as attributes', fixes: [{ title: 'Write the options as attributes', edits: [{ start, end, text: attributes.join(' ') }], safe: true }] })
  }
}
