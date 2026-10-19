import type { CheckDiagnostic } from '../check'
import type { Listed } from './env'
import { dirname, join, relative, resolve } from 'node:path'

// The files `kay env` compares the declared variables with: a compose file or several, and the example env file.
export interface EnvFiles {
  compose?: string | string[] | undefined
  example?: string | undefined
}

interface Assignment {
  name: string
  line: number
  // Whether a value is given that does not take the variable from the environment it is set in.
  literal: boolean
  value?: string
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const ENV_LINE = /^\s*(?:export\s+)?([a-z_]\w*)\s*=(.*)$/i
const QUOTED = /^(["'])(.*)\1$/
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/
const RAW_READ = /\b(?:process\.env|Bun\.env)(?:\.([a-z_]\w*)|\[\s*['"]([a-z_]\w*)['"]\s*\])/gi
// `$$VAR` is an escaped dollar, not a reference.
const INTERPOLATED = /(?<!\$)\$\{?([a-z_]\w*)/gi
const TRAILING_COMMENT = /\s\/\/.*$/
const DESTRUCTURED_ENV = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|Bun\.env)\b/
const LEADING_NAME = /^\s*([a-z_]\w*)\s*(?:[:=,]|$)/i
const LINE_BREAK = /\r?\n/

// Read by kay or the runtime itself, never by a schema.
export const IGNORED_READS = new Set(['NODE_ENV'])

// Every string of a parsed compose file, where its `${VAR}` references are read from: a comment or a key is no reference.
function strings(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]

  if (Array.isArray(value))
    return value.flatMap(strings)

  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(strings) : []
}

// What `KEY=value` lines of an env file assign: comments and blank lines skipped, a quoted value read as it is.
function parseEnvFile(text: string): Assignment[] {
  const found: Assignment[] = []

  for (const [index, row] of text.split(LINE_BREAK).entries()) {
    const match = ENV_LINE.exec(row)

    if (match !== null)
      found.push({ name: match[1]!, line: index + 1, literal: false, value: match[2]!.trim().replace(QUOTED, '$2') })
  }

  return found
}

function refersTo(value: string, name: string): boolean {
  return [...value.matchAll(INTERPOLATED)].some(match => match[1] === name)
}

// What the services of a compose file set for the container: each `environment` entry, and every variable an `env_file` holds.
async function composeAssignments(file: string, text: string, problem: (message: string, line?: number) => void): Promise<{ set: Map<string, Assignment>, interpolated: Set<string> }> {
  const set = new Map<string, Assignment>()
  const interpolated = new Set<string>()
  let document: unknown

  try {
    document = Bun.YAML.parse(text)
  }
  catch (error) {
    problem(`${relative(process.cwd(), file)} is not valid YAML (${error instanceof Error ? error.message : String(error)})`)

    return { set, interpolated }
  }

  for (const value of strings(document)) {
    for (const match of value.matchAll(INTERPOLATED))
      interpolated.add(match[1]!)
  }

  const services = (document as { services?: Record<string, unknown> } | null)?.services

  for (const service of Object.values(services ?? {})) {
    const { environment, env_file: envFile } = (service ?? {}) as { environment?: unknown, env_file?: unknown }

    if (Array.isArray(environment)) {
      for (const entry of environment) {
        const [name, ...value] = String(entry).split('=')
        const given = value.join('=')

        // `FOO=` is how a file says it is not set, as `defineEnv` reads it.
        if (value.length === 0 || given !== '')
          set.set(name!, { name: name!, line: 1, literal: given !== '' && !refersTo(given, name!) })
      }
    }
    else if (typeof environment === 'object' && environment !== null) {
      for (const [name, value] of Object.entries(environment)) {
        if (value !== '')
          set.set(name, { name, line: 1, literal: value !== null && value !== undefined && !refersTo(String(value), name) })
      }
    }

    const entries = Array.isArray(envFile) ? envFile : [envFile].filter(entry => entry !== undefined)
    const paths = entries.map(entry => typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path).filter(path => typeof path === 'string')

    for (const path of paths) {
      const target = resolve(dirname(file), path)
      const source = Bun.file(target)

      if (!await source.exists()) {
        // A file listed as not required is allowed to be missing.
        const required = !entries.some(entry => (entry as { path?: unknown, required?: unknown } | null)?.path === path && (entry as { required?: unknown }).required === false)

        if (required)
          problem(`env_file ${path} of ${relative(process.cwd(), file)} does not exist`)

        continue
      }

      for (const { name, value = '' } of parseEnvFile(await source.text())) {
        if (value !== '')
          set.set(name, { name, line: 1, literal: !refersTo(value, name) })
      }
    }
  }

  return { set, interpolated }
}

// Where a read sits in its line when it is a direct one, a destructured name having no span to replace.
export interface RawRead {
  name: string
  file: string
  line: number
  column?: number
  length?: number
}

// The reads of `process.env.X`, `process.env['X']`, `Bun.env.X` and a one-line `const { X } = process.env` in the project's own sources, tests apart; a read on several lines, through a variable name or `import.meta.env` is not seen, and a trailing `//` comment is dropped.
export async function rawReads(root: string): Promise<RawRead[]> {
  const found: RawRead[] = []
  const files = [...new Bun.Glob('src/**/*.{ts,tsx,js,jsx,mjs,mts,kay}').scanSync({ cwd: root })].sort().filter(file => !TEST_FILE.test(file) && !file.endsWith('.d.ts'))

  for (const file of files) {
    for (const [index, source] of (await Bun.file(join(root, file)).text()).split('\n').entries()) {
      if (COMMENT_LINE.test(source))
        continue

      const row = source.replace(TRAILING_COMMENT, '')
      const direct = [...row.matchAll(RAW_READ)]
      const names = direct.map(match => (match[1] ?? match[2])!)
      const destructured = DESTRUCTURED_ENV.exec(row)?.[1]

      if (destructured !== undefined)
        names.push(...destructured.split(',').flatMap(part => LEADING_NAME.exec(part)?.[1] ?? []))

      for (const [at, name] of names.entries())
        found.push({ name, file: join(root, file), line: index + 1, ...at < direct.length && { column: direct[at]!.index, length: direct[at]![0].length } })
    }
  }

  return found
}

function diagnostic(severity: 'error' | 'warning', file: string, line: number, message: string): CheckDiagnostic {
  return { file, line, column: 1, severity, message }
}

// What the declared variables, the compose files and the example env file say of each other, as problems: a variable production needs that no compose service sets, one the example lacks or has with nothing behind it, and a raw read of the environment no schema declares.
// A module that did not load (`unread`) may hold schemas the declared set lacks, so it is an error of its own and nothing is judged undeclared.
export async function compareEnv(root: string, variables: Listed[], files: EnvFiles, unread: { file: string, error: string }[] = []): Promise<CheckDiagnostic[]> {
  const problems: CheckDiagnostic[] = unread.map(({ file, error }) => diagnostic('error', resolve(root, file), 1, `${file} did not load (${error}), so the variables it declares are not compared`))
  const complete = unread.length === 0
  const composes = (files.compose === undefined ? [] : [files.compose].flat()).map(path => resolve(root, path))
  const examplePath = files.example === undefined ? undefined : resolve(root, files.example)
  const declared = new Set(variables.map(variable => variable.name))
  const set = new Map<string, Assignment>()
  const interpolated = new Set<string>()
  let composeRead = false

  for (const file of composes) {
    const source = Bun.file(file)

    if (!await source.exists()) {
      problems.push(diagnostic('error', file, 1, `${relative(root, file)} does not exist`))

      continue
    }

    composeRead = true

    const read = await composeAssignments(file, await source.text(), (message, line = 1) => problems.push(diagnostic('error', file, line, message)))

    for (const [name, assignment] of read.set)
      set.set(name, assignment)

    for (const name of read.interpolated)
      interpolated.add(name)
  }

  if (composeRead) {
    for (const variable of variables.filter(({ required, source }) => required !== false && source !== 'kay')) {
      if (!set.has(variable.name))
        problems.push(diagnostic('error', composes[0]!, 1, `${variable.name} is required in production (${variable.source}) and no service of ${composes.map(file => relative(root, file)).join(' or ')} sets it`))
    }
  }

  if (examplePath !== undefined) {
    const source = Bun.file(examplePath)

    if (!await source.exists()) {
      problems.push(diagnostic('error', examplePath, 1, `${relative(root, examplePath)} does not exist`))
    }
    else {
      const example = parseEnvFile(await source.text())
      const listed = new Set(example.map(({ name }) => name))

      for (const { name, line } of example) {
        if (complete && !declared.has(name) && !set.has(name) && !interpolated.has(name))
          problems.push(diagnostic('error', examplePath, line, `${name} is in ${relative(root, examplePath)} and no schema declares it${composeRead ? ', no compose service sets it and none interpolates it' : ''}`))
      }

      for (const variable of variables.filter(({ required, source }) => required !== false && source !== 'kay')) {
        if (!listed.has(variable.name) && set.get(variable.name)?.literal !== true)
          problems.push(diagnostic('error', examplePath, 1, `${variable.name} is required in production (${variable.source}) and ${relative(root, examplePath)} does not list it`))
      }
    }
  }

  for (const { name, file, line } of complete ? await rawReads(root) : []) {
    if (!declared.has(name) && !IGNORED_READS.has(name))
      problems.push(diagnostic('warning', file, line, `process.env.${name} is read with no schema declaring it: declare it with defineEnv so kay env lists it`))
  }

  return problems
}
