// Finds a topic in the llms files of kay and of every kayjs-* library the project installed, section by section, as `kay docs` prints it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KAY_ROOT = join(import.meta.dir, '..')
const LIBRARY_PREFIX = 'kayjs-'
const SCOPE = '@kaynooo'
const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^(#{1,6}) (.+)$/
const LINK_LINE = /^\s*[-*]\s+\[[^\]]*\]\([^)]*\)/
const BLOCK_START = /^(?:[-*+]|\d+\.)\s|^#{1,6}\s|^\|/
// A table row whose first cell is one code span, as a lint's or an option's row is, rather than a case in words.
const TABLE_NAME = /^\|\s*`([^`|]+)`\s*\|/
const WORD = /[\w$@][\w$@.-]*[\w$]|[\w$]/g
const CAMEL_PART = /[A-Z]?[a-z\d]+|[A-Z]+(?![a-z])/g
const LEAD_CODE = /^`([^`]+)`/
const WHITESPACE = /\s/
const LABEL_FILE = /\.(?:md|txt)$/
const NOT_SLUG = /[^\w\- ]/g
const SPACE = / /g
const MD_SUFFIX = /\.md$/
const LLMS_SUFFIX = /\/llms\.txt$/
const LEAD_MARKER = /^\s*(?:[-*+]|\d+\.)\s+/
// Release notes and their archives match nearly any word: they are listed and printed when named, never searched.
const UNSEARCHED = /^(?:whats-new|upgrading)/
// Words a question carries that name nothing.
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'my', 'of', 'on', 'or', 'the', 'to', 'use', 'what', 'when', 'where', 'which', 'with', 'without'])
// A section this long prints only its blocks the words match, so that a long reference does not flood the reader.
const LONG_SECTION = 5000
// The weights of a word found where a section names its subject, against its body.
const NAME_WEIGHT = 12
const HEADING_WEIGHT = 8
const TITLE_WEIGHT = 3
const BM25_K = 1.2
const BM25_B = 0.75

export interface DocFile {
  // `kay/actions.md`, `kayjs-ui/llms.txt`
  label: string
  path: string
  title: string
  searched: boolean
  sections: DocSection[]
}

export interface DocSection {
  // `kay/actions.md#forms`, the slug GitHub gives the heading
  label: string
  file: DocFile
  heading: string
  level: number
  // 1-based, of the heading
  line: number
  // The heading to the next heading of its level or above.
  text: string
  // The heading to the next heading at all, what a search scores and prints.
  own: string
  // The labels of the sections under it.
  children: string[]
}

export interface DocMatch {
  section: DocSection
  score: number
  // The words searched, stop words left out.
  terms: string[]
  // Every word is in its heading or a name it documents.
  named: boolean
}

interface Indexed {
  section: DocSection
  names: Set<string>
  heading: Set<string>
  title: Set<string>
  counts: Map<string, number>
  length: number
}

// kay's llms files then each installed library's, the first found walking up from `root` winning a name.
export function docFiles(root: string): DocFile[] {
  return [...packageFiles('kay', KAY_ROOT), ...libraries(root).flatMap(([name, dir]) => packageFiles(name, dir))]
}

function libraries(root: string): [string, string][] {
  const found = new Map<string, string>()

  for (let dir = root; ; dir = join(dir, '..')) {
    const scope = join(dir, 'node_modules', SCOPE)

    for (const name of existsSync(scope) ? readdirSync(scope).sort() : []) {
      if (name.startsWith(LIBRARY_PREFIX) && !found.has(name) && existsSync(join(scope, name, 'llms.txt')))
        found.set(name, join(scope, name))
    }

    if (join(dir, '..') === dir)
      return [...found]
  }
}

function packageFiles(name: string, dir: string): DocFile[] {
  const llms = join(dir, 'llms')
  const topics = existsSync(llms) ? readdirSync(llms).filter(file => file.endsWith('.md')).sort() : []

  return [
    parseFile(name, 'llms.txt', join(dir, 'llms.txt')),
    ...topics.map(file => parseFile(name, file, join(llms, file))),
  ].filter(file => file !== undefined)
}

function parseFile(name: string, file: string, path: string): DocFile | undefined {
  if (!existsSync(path))
    return undefined

  const lines = readFileSync(path, 'utf8').split('\n')
  const doc: DocFile = { label: `${name}/${file}`, path, title: file, searched: !UNSEARCHED.test(file), sections: [] }
  const heads = headings(lines)
  const slugs = new Map<string, number>()

  for (const [index, head] of heads.entries()) {
    const next = heads[index + 1]?.line ?? lines.length
    const end = heads.slice(index + 1).find(other => head.level === 1 || other.level <= head.level)?.line ?? lines.length
    const base = slug(head.heading)
    const seen = slugs.get(base) ?? 0

    slugs.set(base, seen + 1)
    doc.sections.push({
      label: `${doc.label}#${seen === 0 ? base : `${base}-${seen}`}`,
      file: doc,
      heading: head.heading,
      level: head.level,
      line: head.line + 1,
      text: trimEnd(lines.slice(head.line, end)),
      own: trimEnd(lines.slice(head.line, next)),
      children: [],
    })
  }

  for (const [index, section] of doc.sections.entries()) {
    const under = doc.sections.slice(index + 1)
    const end = under.findIndex(other => other.level <= section.level)

    section.children = (end === -1 ? under : under.slice(0, end)).filter(child => child.level === section.level + 1 || section.level === 1).map(child => child.label)
  }

  doc.title = doc.sections.find(section => section.level === 1)?.heading ?? file

  return doc
}

function headings(lines: string[]): { line: number, level: number, heading: string }[] {
  const found: { line: number, level: number, heading: string }[] = []
  let fence: string | undefined

  for (const [line, text] of lines.entries()) {
    const marker = FENCE.exec(text)?.[1]

    if (marker !== undefined) {
      fence = fenceAfter(fence, marker)

      continue
    }

    const heading = fence === undefined ? HEADING.exec(text) : null

    if (heading !== null)
      found.push({ line, level: heading[1]!.length, heading: heading[2]!.trim() })
  }

  return found
}

// The fence open after a line of backticks or tildes: it opens one, or closes the one open when it is as long and of the same character.
function fenceAfter(fence: string | undefined, marker: string): string | undefined {
  if (fence === undefined)
    return marker

  return marker[0] === fence[0] && marker.length >= fence.length ? undefined : fence
}

// What a label names before its `#`.
export function labelPath(label: string): string {
  const hash = label.indexOf('#')

  return hash === -1 ? label : label.slice(0, hash)
}

function trimEnd(lines: string[]): string {
  return lines.join('\n').trimEnd()
}

// The anchor GitHub gives a heading.
export function slug(heading: string): string {
  return heading.toLowerCase().replace(NOT_SLUG, '').replace(SPACE, '-')
}

// The file or the section a label such as `kayjs-ui/forms-and-steps#steps` names, its `.md` and its package's `@kaynooo/` optional.
export function findLabel(files: DocFile[], label: string): { file: DocFile, section?: DocSection } | undefined {
  const path = labelPath(label)
  const anchor = label.slice(path.length + 1)
  const wanted = path.replace(`${SCOPE}/`, '').toLowerCase()
  const file = files.find(doc => [doc.label, doc.label.replace(MD_SUFFIX, ''), doc.label.replace(LLMS_SUFFIX, '/llms')].includes(wanted))

  if (file === undefined || anchor === '')
    return file && { file }

  const section = file.sections.find(one => one.label === `${file.label}#${anchor.toLowerCase()}`) ?? file.sections.find(one => slug(one.heading) === slug(anchor))

  return section && { file, section }
}

// Whether an argument reads as a label rather than words to search.
export function isLabel(files: DocFile[], argument: string): boolean {
  return argument.includes('/') && findLabel(files, labelPath(argument)) !== undefined
}

// Whether an argument can only be meant as a label, naming a `.md` or `.txt` file or a heading, so that one naming nothing fails rather than being searched.
export function looksLikeLabel(argument: string): boolean {
  return !WHITESPACE.test(argument) && argument.includes('/') && (argument.includes('#') || LABEL_FILE.test(labelPath(argument)))
}

// The sections the words match, the best first.
export function searchDocs(files: DocFile[], query: string): DocMatch[] {
  const words = wordsOf(query, false)
  const terms = [...new Set(words.filter(word => !STOP_WORDS.has(word)))]
  const wanted = terms.length > 0 ? terms : [...new Set(words)]

  if (wanted.length === 0)
    return []

  const index = files.filter(file => file.searched).flatMap(file => file.sections.filter(searchable).map(indexed))
  const average = index.reduce((sum, one) => sum + one.length, 0) / Math.max(index.length, 1)
  const idf = new Map(wanted.map((term) => {
    const holding = index.filter(one => one.counts.has(term) || one.heading.has(term) || one.names.has(term)).length

    return [term, Math.log(1 + (index.length - holding + 0.5) / (holding + 0.5))]
  }))
  const matches: DocMatch[] = []

  for (const one of index) {
    let score = 0
    let matched = 0
    let named = 0

    for (const term of wanted) {
      const weight = idf.get(term)!
      const count = one.counts.get(term) ?? 0
      const found = (one.names.has(term) ? NAME_WEIGHT : 0) + (one.heading.has(term) ? HEADING_WEIGHT : 0) + (one.title.has(term) ? TITLE_WEIGHT : 0) + count * (BM25_K + 1) / (count + BM25_K * (1 - BM25_B + BM25_B * one.length / average))

      if (found > 0)
        matched++

      if (one.names.has(term) || one.heading.has(term))
        named++

      score += weight * found
    }

    if (score > 0)
      matches.push({ section: one.section, score: score * (matched / wanted.length) ** 2, terms: wanted, named: named === wanted.length })
  }

  return matches.sort((a, b) => b.score - a.score || a.section.own.length - b.section.own.length)
}

// A section with text of its own that is no list of links.
function searchable(section: DocSection): boolean {
  const body = section.own.split('\n').slice(1).filter(line => line.trim() !== '')

  return body.length > 0 && body.filter(line => LINK_LINE.test(line)).length < body.length * 0.5
}

function indexed(section: DocSection): Indexed {
  const body = wordsOf(section.own.split('\n').slice(1).join('\n'))
  const counts = new Map<string, number>()

  for (const word of body)
    counts.set(word, (counts.get(word) ?? 0) + 1)

  return {
    section,
    names: new Set([...wordsOf(section.heading), ...blocks(section.own).flatMap(lead)]),
    heading: new Set(wordsOf(section.heading)),
    title: new Set(wordsOf(section.file.title)),
    counts,
    length: body.length,
  }
}

// The names a block opens on, which the section documents: the first code span or words of a paragraph or an item, a table row's first cell.
function lead(block: string): string[] {
  const end = block.indexOf('\n')
  const first = end === -1 ? block : block.slice(0, end)
  const cell = TABLE_NAME.exec(first)?.[1]

  if (cell !== undefined)
    return wordsOf(cell)

  if (first.startsWith('|'))
    return []

  const text = first.replace(LEAD_MARKER, '')
  const code = LEAD_CODE.exec(text)?.[1]

  return code === undefined ? wordsOf(text).slice(0, 3).filter(word => !STOP_WORDS.has(word)) : wordsOf(code).slice(0, 2)
}

// Lowercased words, a plural as its singular, and in the docs a camel-cased or dotted name also as its parts, so that `form dialogs` finds `FormDialog` while `s.Object` searched finds only itself.
function wordsOf(text: string, parts = true): string[] {
  const words: string[] = []

  for (const [raw] of text.matchAll(WORD)) {
    const split = parts ? raw.match(CAMEL_PART) ?? [] : []

    words.push(stem(raw.toLowerCase()), ...split.length > 1 ? split.map(part => stem(part.toLowerCase())) : [])
  }

  return words
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

// The blocks of a section: its paragraphs, list items and table rows, a code fence staying in the block it follows.
function blocks(text: string): string[] {
  const found: string[][] = []
  let fence: string | undefined
  let blank = true

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    const inFence = fence !== undefined

    if (marker !== undefined)
      fence = fenceAfter(fence, marker)

    if (!inFence && marker === undefined && line.trim() === '') {
      blank = true

      continue
    }

    if (found.length === 0 || (!inFence && marker === undefined && (blank || BLOCK_START.test(line))))
      found.push([line])
    else
      found.at(-1)!.push(...blank ? ['', line] : [line])

    blank = false
  }

  return found.map(lines => lines.join('\n'))
}

// A match as a search prints it: the section's own text, or the blocks the words match when it is long, with how many it left out.
export function excerpt({ section, terms }: DocMatch): { text: string, omitted: number } {
  if (section.own.length <= LONG_SECTION)
    return { text: section.own, omitted: 0 }

  const [heading = '', ...rest] = blocks(section.own)
  const kept = rest.filter(block => wordsOf(block).some(word => terms.includes(word)))
  const shown = kept.length > 0 ? kept : rest.slice(0, 1)

  return { text: [heading, ...shown].join('\n\n'), omitted: rest.length - shown.length }
}
