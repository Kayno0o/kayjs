import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { insertImport } from '../imports'
import { IGNORED_READS, rawReads } from './env-compare'

interface Edit {
  start: number
  end: number
  text: string
}

interface Candidate {
  file: string
  edit: Edit
  // The `?? 'literal'` the read ends with, when it has one.
  fallback: { value: string, end: number } | undefined
}

const DEFINE_ENV = /\bdefineEnv\s*\(/
const SCHEMA = /export const env = defineEnv\(\s*(s|t)\.Object\(\{(?=\r?\n|\})/
const FALLBACK = /^\s*\?\?\s*(?:'([^'\\\n]*)'|"([^"'\\\n]*)")(?=\s*(?:[;,)\]}]|\/\/|$))/
const ASSIGNED = /^\s*(?:\?\?|\|\||&&|\*\*|<<|>>>|>>|[-+*/%&|^])?=(?![=>])/
const DELETED = /\bdelete\s+$/
const ENV_NAME = /(?<![.\w$])env(?![\w$])/
const RAW_START = /^(?:process\.env|Bun\.env)/
const SCHEMA_PATH = /\.[mc]?ts$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXTENSION = /\.[mc]?[jt]s$/
const INDENT = /\n([ \t]+)\S/
const IDENTIFIER_CHAR = /[\p{ID_Continue}$]/u
const WHITESPACE = /\s/
// The words after which a `/` opens a regular expression.
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
// What a value ends with, after which a `/` divides.
const VALUE_END = ')]}"'

// Which characters of `text` are code, and not a string, a template's text, a comment or a regular expression.
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  // The open template literals (`) and braces ({) around the character read.
  const stack: string[] = []
  // What the code read last, to tell a regular expression from a division: its word, else its last character, a quote standing for a string, a template or a regular expression just read.
  let word = ''
  let last = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]!
    const next = text[index + 1]

    if (stack.at(-1) === '`') {
      if (char === '\\') {
        index += 2
      }
      else if (char === '`') {
        stack.pop()
        word = ''
        last = '"'
        index++
      }
      else if (char === '$' && next === '{') {
        stack.push('{')
        word = ''
        last = '{'
        index += 2
      }
      else {
        index++
      }
    }
    else if (char === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2)

      index = end === -1 ? text.length : end + 1
    }
    else if (char === '\'' || char === '"') {
      index++

      while (index < text.length && text[index] !== char && text[index] !== '\n')
        index += text[index] === '\\' ? 2 : 1

      index++
      word = ''
      last = '"'
    }
    else {
      const regexEnd = char === '/' && startsExpression(word, last) ? regexLiteralEnd(text, index) : undefined

      if (regexEnd !== undefined) {
        index = regexEnd + 1
        word = ''
        last = '"'

        continue
      }

      if (char === '`' || char === '{')
        stack.push(char)
      else if (char === '}' && stack.at(-1) === '{')
        stack.pop()

      if (IDENTIFIER_CHAR.test(char)) {
        word = IDENTIFIER_CHAR.test(text[index - 1] ?? ' ') ? word + char : char
      }
      else if (!WHITESPACE.test(char)) {
        word = ''
        // `i++ / 2` divides.
        last = (char === '+' || char === '-') && text[index - 1] === char ? ')' : char
      }

      mask[index++] = 1
    }
  }

  return mask
}

// Whether a `/` after this word or character opens a regular expression, and is no division.
function startsExpression(word: string, last: string): boolean {
  return word !== '' ? REGEX_KEYWORDS.has(word) && last !== '.' : last === '' || !VALUE_END.includes(last)
}

// Where the regular expression opening at `start` closes, a `/` outside a class on the same line.
function regexLiteralEnd(text: string, start: number): number | undefined {
  let inClass = false

  for (let index = start + 1; index < text.length && text[index] !== '\n'; index++) {
    const char = text[index]

    if (char === '\\')
      index++
    else if (char === '[')
      inClass = true
    else if (char === ']')
      inClass = false
    else if (char === '/' && !inClass)
      return index
  }

  return undefined
}

// The schema file a variable is added to: the project's `export const env = defineEnv(s.Object({` when it has one, `src/env.ts` when it has no `defineEnv` at all, nothing when it declares them in another shape.
async function schemaFile(root: string): Promise<{ file: string, existing: { prefix: string, at: number } | undefined } | undefined> {
  const files = [...new Bun.Glob('src/**/*.{ts,tsx,js,mjs,mts,kay}').scanSync({ cwd: root })].sort().filter(file => !TEST_FILE.test(file))
  const holders: { file: string, text: string }[] = []

  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8')

    if (DEFINE_ENV.test(text))
      holders.push({ file: join(root, file), text })
  }

  if (holders.length === 0)
    return files.includes('src/env.ts') ? undefined : { file: join(root, 'src/env.ts'), existing: undefined }

  const [only, ...others] = holders
  const found = others.length === 0 ? SCHEMA.exec(only!.text) : null

  return found === null || !SCHEMA_PATH.test(only!.file) ? undefined : { file: only!.file, existing: { prefix: found[1]!, at: found.index + found[0].length } }
}

function field(prefix: string, name: string, fallback: string | undefined): string {
  return `${name}: ${fallback === undefined ? `${prefix}.Optional(${prefix}.String())` : `${prefix}.String({ default: '${fallback}' })`}`
}

// Declares the variables `process.env.X` is read for with no schema, in the schema file of the project, and rewrites their reads to `env.X`, a `?? 'default'` becoming the variable's default. `files` are the only files it may change: a variable with a read outside them is left alone, as is one whose read is assigned or deleted, destructured, in a `.kay` file or a file with an `env` of its own, inside a string, a template or a comment, or in the schema file itself. Answers the variables declared and the reads rewritten.
export async function declareRawEnv(root: string, undeclared: ReadonlySet<string>, files: ReadonlySet<string>): Promise<{ names: Set<string>, reads: number }> {
  const reads = (await rawReads(root)).filter(({ name }) => undeclared.has(name) && !IGNORED_READS.has(name))
  const names = new Set<string>()
  const schema = reads.length === 0 ? undefined : await schemaFile(root)

  if (schema === undefined)
    return { names, reads: 0 }

  const sources = new Map<string, { text: string, lines: string[], starts: number[], mask: Uint8Array }>()

  for (const file of new Set(reads.map(read => read.file))) {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    let start = 0

    sources.set(file, { text, lines, starts: lines.map((line) => {
      const at = start

      start += line.length + 1

      return at
    }), mask: codeMask(text) })
  }

  const found = new Map<string, Candidate[]>()

  for (const [name, group] of Map.groupBy(reads, read => read.name)) {
    const candidates: Candidate[] = []

    for (const { file, line, column, length } of group) {
      const { text, lines, starts, mask } = sources.get(file)!
      const row = lines[line - 1]!
      const start = starts[line - 1]! + (column ?? 0)
      // A read whose span is not where the scan saw it, such as after a byte order mark, is not touched.
      const ok = column !== undefined && length !== undefined && files.has(file) && file !== schema.file && EXTENSION.test(file) && !(name in Object.prototype) && RAW_START.test(row.slice(column)) && mask[start] === 1 && !ENV_NAME.test(text) && !ASSIGNED.test(row.slice(column + length)) && !DELETED.test(row.slice(0, column))

      if (!ok)
        break

      const fallback = FALLBACK.exec(row.slice(column + length))
      const value = fallback?.[1] ?? fallback?.[2]

      candidates.push({ file, edit: { start, end: start + length, text: `env.${name}` }, fallback: fallback === null || value === undefined ? undefined : { value, end: start + length + fallback[0].length } })
    }

    if (candidates.length === group.length)
      found.set(name, candidates)
  }

  if (found.size === 0)
    return { names, reads: 0 }

  const fields: string[] = []
  const edits = new Map<string, Edit[]>()

  for (const [name, candidates] of [...found].sort(([a], [b]) => a < b ? -1 : 1)) {
    const values = new Set(candidates.map(({ fallback }) => fallback?.value))
    const value = values.size === 1 ? [...values][0] : undefined

    fields.push(field(schema.existing?.prefix ?? 's', name, value))
    names.add(name)

    for (const { file, edit, fallback } of candidates)
      edits.set(file, [...edits.get(file) ?? [], value === undefined || fallback === undefined ? edit : { ...edit, end: fallback.end }])
  }

  // The schema goes first, so a failed write leaves no file importing what is not there.
  if (schema.existing === undefined) {
    await writeFile(schema.file, `import { defineEnv, s } from 'kay/server'\n\nexport const env = defineEnv(s.Object({\n${fields.map(line => `  ${line},\n`).join('')}}))\n`)
  }
  else {
    const text = await readFile(schema.file, 'utf8')
    const { at } = schema.existing
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const indent = INDENT.exec(text.slice(at))?.[1] ?? '  '

    await writeFile(schema.file, `${text.slice(0, at)}${fields.map(line => `${eol}${indent}${line},`).join('')}${text[at] === '}' ? eol : ''}${text.slice(at)}`)
  }

  for (const [file, list] of edits) {
    const target = relative(dirname(file), schema.file).replace(EXTENSION, '')
    const source = list.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), sources.get(file)!.text)

    await writeFile(file, insertImport(source, `import { env } from '${target.startsWith('.') ? target : `./${target}`}'`))
  }

  return { names, reads: [...edits.values()].reduce((sum, list) => sum + list.length, 0) }
}
