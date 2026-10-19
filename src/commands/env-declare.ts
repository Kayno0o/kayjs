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
const SCHEMA_PATH = /\.[mc]?ts$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXTENSION = /\.[mc]?[jt]s$/
const INDENT = /\n([ \t]+)\S/

// Whether an odd number of unescaped `quote` precedes the end of `text`, so what follows sits inside a string.
function insideString(text: string, quote: string): boolean {
  let open = false

  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\')
      index++
    else if (text[index] === quote)
      open = !open
  }

  return open
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

// Declares the variables `process.env.X` is read for with no schema, in the schema file of the project, and rewrites their reads to `env.X`, a `?? 'default'` becoming the variable's default. A variable is left alone, its warning with it, when any of its reads is in a shape this cannot rewrite safely: assigned or deleted, destructured, in a `.kay` file or a file with an `env` of its own, inside a string, or in the schema file itself. Answers the variables declared and the reads rewritten.
export async function declareRawEnv(root: string, undeclared: ReadonlySet<string>): Promise<{ names: Set<string>, reads: number }> {
  const reads = (await rawReads(root)).filter(({ name }) => undeclared.has(name) && !IGNORED_READS.has(name))
  const names = new Set<string>()
  const schema = reads.length === 0 ? undefined : await schemaFile(root)

  if (schema === undefined)
    return { names, reads: 0 }

  const texts = new Map<string, string>()

  for (const file of new Set(reads.map(read => read.file)))
    texts.set(file, await readFile(file, 'utf8'))

  const byName = Map.groupBy(reads, read => read.name)
  const found = new Map<string, Candidate[]>()

  for (const [name, group] of byName) {
    const candidates: Candidate[] = []

    for (const { file, line, column, length } of group) {
      const text = texts.get(file)!
      const lines = text.split('\n')
      const row = lines[line - 1]!
      const before = row.slice(0, column)
      const tail = row.slice((column ?? 0) + (length ?? 0))
      const ok = column !== undefined && length !== undefined && file !== schema.file && EXTENSION.test(file) && !ENV_NAME.test(text) && !ASSIGNED.test(tail) && !DELETED.test(before) && !insideString(before, '\'') && !insideString(before, '"')

      if (!ok) {
        candidates.length = 0

        break
      }

      const start = lines.slice(0, line - 1).reduce((sum, previous) => sum + previous.length + 1, 0) + column
      const fallback = FALLBACK.exec(tail)
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

  for (const [file, list] of edits) {
    const target = relative(dirname(file), schema.file).replace(EXTENSION, '')
    const source = list.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), texts.get(file)!)

    await writeFile(file, insertImport(source, `import { env } from '${target.startsWith('.') ? target : `./${target}`}'`))
  }

  if (schema.existing === undefined) {
    await writeFile(schema.file, `import { s } from 'kay'\nimport { defineEnv } from 'kay/server'\n\nexport const env = defineEnv(s.Object({\n${fields.map(line => `  ${line},\n`).join('')}}))\n`)
  }
  else {
    const text = await readFile(schema.file, 'utf8')
    const { at } = schema.existing
    const indent = INDENT.exec(text.slice(at))?.[1] ?? '  '
    const added = fields.map(line => `\n${indent}${line},`).join('')

    await writeFile(schema.file, `${text.slice(0, at)}${added}${text[at] === '}' ? '\n' : ''}${text.slice(at)}`)
  }

  return { names, reads: [...edits.values()].reduce((sum, list) => sum + list.length, 0) }
}
