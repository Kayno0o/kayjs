// What a new entry's slug is helped with: written from a title, cleaned as it is typed, and checked against the slugs the collection holds.
const MARKS = /\p{M}/gu
const LETTERS = { œ: 'oe', æ: 'ae', ß: 'ss', ø: 'o', đ: 'd', ł: 'l', þ: 'th' } as const
const LIGATURE = /[œæßøđłþ]/g
const OTHER = /[^\p{L}\p{N}/_-]+/gu
const DASHES = /-{2,}/g
const SLASHES = /\/{2,}/g
const AROUND_SLASH = /-*\/-*/g
// Years and numbers differ by a digit on purpose, so they are never a typo of each other.
const NUMBER = /^\d+$/
const LEADING = /^[-/]+/
const EDGES = /^[-/]+|[-/]+$/g

// A slug from the text typed, letters and digits of any script kept (Latin marks dropped, so a Cyrillic or CJK title gives its own letters), case lowered, spaces and punctuation turned to `-` and `/` kept between folders. While typing (`final` left off) a trailing `-` or `/` stays, since the next letter comes after it.
export function slugify(text: string, { final = false }: { final?: boolean } = {}): string {
  const slug = text
    .normalize('NFKD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(LIGATURE, letter => LETTERS[letter as keyof typeof LETTERS])
    .replace(OTHER, '-')
    .replace(DASHES, '-')
    .replace(SLASHES, '/')
    .replace(AROUND_SLASH, '/')
    .replace(LEADING, '')

  return final ? slug.replace(EDGES, '') : slug
}

export interface SlugReport {
  // The collection holds an entry under this slug already.
  taken: boolean
  // The deepest folder of the slug that exists, `''` for the collection's own.
  inside: string
  // The folders the slug would create, such as `2024/drafts`; undefined when every folder exists.
  created: string | undefined
  // An existing folder next to the first one created that it may have meant, such as `notes` for `notess`.
  near: string | undefined
}

// The distance between two short texts: single-letter edits and swaps of two neighbours.
function distance(a: string, b: string): number {
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)]

  for (let i = 1; i <= a.length; i++) {
    const row = [i]

    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1)

      row.push(best)
    }

    rows.push(row)
  }

  return rows[a.length]![b.length]!
}

// Where a slug lands among the slugs the collection holds: whether it is taken, and which of its folders exist, which would be created and which looks like a typo of one that exists.
export function checkSlug(slug: string, existing: readonly string[]): SlugReport {
  const taken = existing.includes(slug)
  const folders = new Set<string>()

  for (const other of existing) {
    const parts = other.split('/').slice(0, -1)

    for (let end = 1; end <= parts.length; end++)
      folders.add(parts.slice(0, end).join('/'))
  }

  const parts = slug.split('/').slice(0, -1)
  let known = 0

  while (known < parts.length && folders.has(parts.slice(0, known + 1).join('/')))
    known++

  const inside = parts.slice(0, known).join('/')

  if (known === parts.length)
    return { taken, inside, created: undefined, near: undefined }

  const first = parts[known]!
  const allowed = Math.max(1, Math.floor(first.length / 4))
  const siblings = [...folders].filter(folder => folder.split('/').length === known + 1 && folder.startsWith(known === 0 ? '' : `${inside}/`)).map(folder => folder.slice(inside === '' ? 0 : inside.length + 1))
  const near = first.length < 3 || NUMBER.test(first) ? undefined : siblings.filter(sibling => distance(first, sibling) <= allowed).sort((a, b) => distance(first, a) - distance(first, b))[0]

  const nearPath = inside === '' ? near : `${inside}/${near}`

  return { taken, inside, created: parts.slice(known).join('/'), near: near === undefined ? undefined : nearPath }
}
