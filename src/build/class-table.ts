import type { Design } from '../format/tailwind'
import type { ClassTable } from '../runtime/class-table'
import { tailwindDesign } from '../format/tailwind'

// A class as the table sees it: the variants it applies under, and the CSS properties it sets.
interface Parsed {
  context: string
  own: string[]
}

const SKIPPED_BLOCK = /^@(?:property|keyframes)\b/
// What `space-*` and `divide-*` write: the element's children, whose properties are kept apart from the element's own.
const CHILDREN_BLOCK = /^:where\(/
const SIDES = ['top', 'right', 'bottom', 'left', 'inline', 'block', 'inline-start', 'inline-end', 'block-start', 'block-end']
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'start-start', 'start-end', 'end-start', 'end-end']

// The properties a shorthand also sets, which Tailwind's `p-6` (`padding`) does over a `px-4` (`padding-inline`).
// The only table kept by hand: Tailwind emits whichever property its utility names, and CSS alone tells which ones a shorthand covers.
const LONGHANDS: Record<string, string[]> = (() => {
  const result: Record<string, string[]> = {
    'gap': ['row-gap', 'column-gap'],
    'place-items': ['align-items', 'justify-items'],
    'place-content': ['align-content', 'justify-content'],
    'place-self': ['align-self', 'justify-self'],
    'grid-column': ['grid-column-start', 'grid-column-end'],
    'grid-row': ['grid-row-start', 'grid-row-end'],
    'overflow': ['overflow-x', 'overflow-y'],
    'overscroll-behavior': ['overscroll-behavior-x', 'overscroll-behavior-y'],
    'border-radius': CORNERS.map(corner => `border-${corner}-radius`),
    'flex': ['flex-grow', 'flex-shrink', 'flex-basis'],
    'inset': ['top', 'right', 'bottom', 'left', 'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end'],
    'inset-inline': ['inset-inline-start', 'inset-inline-end'],
    'inset-block': ['inset-block-start', 'inset-block-end'],
  }

  for (const base of ['padding', 'margin', 'scroll-margin', 'scroll-padding']) {
    result[base] = SIDES.map(side => `${base}-${side}`)
    result[`${base}-inline`] = [`${base}-inline-start`, `${base}-inline-end`]
    result[`${base}-block`] = [`${base}-block-start`, `${base}-block-end`]
  }

  for (const aspect of ['width', 'style', 'color']) {
    result[`border-${aspect}`] = SIDES.map(side => `border-${side}-${aspect}`)
    result[`border-inline-${aspect}`] = [`border-inline-start-${aspect}`, `border-inline-end-${aspect}`]
    result[`border-block-${aspect}`] = [`border-block-start-${aspect}`, `border-block-end-${aspect}`]
  }

  return result
})()

// What a property overrides: itself and every longhand under it, a shorthand's longhands' own longhands included.
function covering(property: string, seen = new Set<string>()): Set<string> {
  seen.add(property)

  for (const longhand of LONGHANDS[property] ?? []) {
    if (!seen.has(longhand))
      covering(longhand, seen)
  }

  return seen
}

// The property names declared in a rule's text, `@property` and `@keyframes` blocks left out, and custom properties Tailwind uses as its own state (`--tw-*`) kept: a class setting `--tw-shadow` is not overridden by one that only sets `box-shadow`.
export function declaredProperties(css: string): string[] {
  const names = new Set<string>()
  const skipped: boolean[] = []
  const children: boolean[] = []
  let current = ''
  let depth = 0
  let quote = ''

  const declaration = () => {
    const text = current.trim()
    const colon = text.indexOf(':')

    if (colon > 0 && !skipped.includes(true) && !text.startsWith('@'))
      names.add(`${children.includes(true) ? '>' : ''}${text.slice(0, colon).trim()}`)

    current = ''
  }

  for (const char of css) {
    if (quote !== '') {
      current += char

      if (char === quote)
        quote = ''

      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      current += char
    }
    else if (char === '(') {
      depth++
      current += char
    }
    else if (char === ')') {
      depth--
      current += char
    }
    else if (depth > 0) {
      current += char
    }
    else if (char === '{') {
      skipped.push(SKIPPED_BLOCK.test(current.trim()))
      children.push(CHILDREN_BLOCK.test(current.trim()))
      current = ''
    }
    else if (char === '}') {
      declaration()
      skipped.pop()
      children.pop()
    }
    else if (char === ';') {
      declaration()
    }
    else {
      current += char
    }
  }

  return [...names]
}

// The variants and importance of a class, `md:hover:` and `!`, which decide whether two classes meet at all.
export function contextOf(name: string): string {
  let depth = 0
  let split = -1

  for (let index = 0; index < name.length; index++) {
    const char = name[index]

    if (char === '[' || char === '(')
      depth++
    else if (char === ']' || char === ')')
      depth--
    else if (char === ':' && depth === 0)
      split = index
  }

  const utility = name.slice(split + 1)
  const important = utility.startsWith('!') || utility.endsWith('!')

  return `${name.slice(0, split + 1)}${important ? '!' : ''}`
}

const parsed = new WeakMap<Design, Map<string, Parsed | null>>()

function parse(design: Design, words: string[]): Map<string, Parsed | null> {
  let known = parsed.get(design)

  if (known === undefined)
    parsed.set(design, known = new Map<string, Parsed | null>())

  const fresh = words.filter(word => !known.has(word))

  for (let at = 0; at < fresh.length; at += 500) {
    const chunk = fresh.slice(at, at + 500)
    let css: (string | null)[] = []

    try {
      css = design.candidatesToCss(chunk)
    }
    catch {
      // One word Tailwind chokes on loses its chunk; they are read one by one.
      css = chunk.map((word) => {
        try {
          return design.candidatesToCss([word])[0] ?? null
        }
        catch {
          return null
        }
      })
    }

    for (const [index, word] of chunk.entries()) {
      const text = css[index]
      const own = text === undefined || text === null || text === '' ? [] : declaredProperties(text)

      known.set(word, own.length === 0 ? null : { context: contextOf(word), own })
    }
  }

  return known
}

// Which classes of `words` another of them overrides, from what the app's own Tailwind makes of each: the table the runtime merges with.
// Left out are the classes that meet no other, so an app using few utilities ships a small table; undefined when the app has no Tailwind or none of its classes conflicts.
export async function buildClassTable(root: string, words: Iterable<string>): Promise<ClassTable | undefined> {
  const design = await tailwindDesign(root)

  if (design === undefined)
    return undefined

  const known = parse(design, [...new Set(words)])
  const byContext = new Map<string, [string, Parsed][]>()

  for (const [word, entry] of known) {
    if (entry === null)
      continue

    const list = byContext.get(entry.context) ?? []

    list.push([word, entry])
    byContext.set(entry.context, list)
  }

  const sets: number[][] = []
  const setIndex = new Map<string, number>()
  const properties = new Map<string, number>()
  const contexts = new Map<string, number>()
  const classes: ClassTable['classes'] = {}

  const intern = (names: Iterable<string>): number => {
    const ids = [...names].map((name) => {
      let id = properties.get(name)

      if (id === undefined)
        properties.set(name, id = properties.size)

      return id
    }).toSorted((a, b) => a - b)
    const key = ids.join(',')
    let index = setIndex.get(key)

    if (index === undefined) {
      index = sets.length
      sets.push(ids)
      setIndex.set(key, index)
    }

    return index
  }

  for (const [context, list] of byContext) {
    // A class can meet another only through a property that one sets and the other covers.
    const ownCount = new Map<string, number>()
    const coverCount = new Map<string, number>()
    const covers = new Map<string, Set<string>>()

    for (const [word, entry] of list) {
      const all = new Set(entry.own.flatMap(property => [...covering(property)]))

      covers.set(word, all)

      for (const property of new Set(entry.own))
        ownCount.set(property, (ownCount.get(property) ?? 0) + 1)

      for (const property of all)
        coverCount.set(property, (coverCount.get(property) ?? 0) + 1)
    }

    for (const [word, entry] of list) {
      const all = covers.get(word)!
      const meets = [...all].some(property => (ownCount.get(property) ?? 0) > (entry.own.includes(property) ? 1 : 0)) || entry.own.some(property => (coverCount.get(property) ?? 0) > 1)

      if (!meets)
        continue

      let id = contexts.get(context)

      if (id === undefined)
        contexts.set(context, id = contexts.size)

      const own = intern(entry.own)
      const cover = intern(all)

      classes[word] = cover === own ? [id, own] : [id, own, cover]
    }
  }

  return Object.keys(classes).length === 0 ? undefined : { sets, classes }
}
