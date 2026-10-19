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
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const ENV_LINE = /^\s*(?:export\s+)?([a-z_]\w*)\s*=(.*)$/i
const QUOTED = /^(["'])(.*)\1$/
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/
const RAW_READ = /\b(?:process\.env|Bun\.env)(?:\.([a-z_]\w*)|\[\s*['"]([a-z_]\w*)['"]\s*\])/gi
const INTERPOLATED = /\$\{?([a-z_]\w*)/gi
const LINE_BREAK = /\r?\n/
// Read by kay or the runtime itself, never by a schema.
const IGNORED_READS = new Set(['NODE_ENV'])

// What `KEY=value` lines of an env file assign: comments and blank lines skipped, a quoted value read as it is.
function parseEnvFile(text: string): Assignment[] {
  const found: Assignment[] = []

  for (const [index, row] of text.split(LINE_BREAK).entries()) {
    const match = ENV_LINE.exec(row)

    if (match !== null)
      found.push({ name: match[1]!, line: index + 1, literal: match[2]!.trim().replace(QUOTED, '$2') !== '' })
  }

  return found
}

function refersTo(value: string, name: string): boolean {
  return [...value.matchAll(INTERPOLATED)].some(match => match[1] === name)
}

// What the services of a compose file set for the container: each `environment` entry, and every variable an `env_file` holds.
async function composeAssignments(file: string, text: string, problem: (message: string, line?: number) => void): Promise<{ set: Map<string, Assignment>, interpolated: Set<string> }> {
  const set = new Map<string, Assignment>()
  const interpolated = new Set([...text.matchAll(INTERPOLATED)].map(match => match[1]!))
  let document: unknown

  try {
    document = Bun.YAML.parse(text)
  }
  catch (error) {
    problem(`${relative(process.cwd(), file)} is not valid YAML (${error instanceof Error ? error.message : String(error)})`)

    return { set, interpolated }
  }

  const services = (document as { services?: Record<string, unknown> } | null)?.services

  for (const service of Object.values(services ?? {})) {
    const { environment, env_file: envFile } = (service ?? {}) as { environment?: unknown, env_file?: unknown }

    if (Array.isArray(environment)) {
      for (const entry of environment) {
        const [name, ...value] = String(entry).split('=')

        set.set(name!, { name: name!, line: 1, literal: value.length > 0 && !refersTo(value.join('='), name!) })
      }
    }
    else if (typeof environment === 'object' && environment !== null) {
      for (const [name, value] of Object.entries(environment)) {
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

      for (const assignment of parseEnvFile(await source.text()))
        set.set(assignment.name, { ...assignment, line: 1, literal: false })
    }
  }

  return { set, interpolated }
}

// The reads of `process.env.X` and `Bun.env.X` in the project's own sources, tests apart.
async function rawReads(root: string): Promise<{ name: string, file: string, line: number }[]> {
  const found: { name: string, file: string, line: number }[] = []
  const files = [...new Bun.Glob('src/**/*.{ts,tsx,js,kay}').scanSync({ cwd: root })].sort().filter(file => !TEST_FILE.test(file) && !file.endsWith('.d.ts'))

  for (const file of files) {
    for (const [index, row] of (await Bun.file(join(root, file)).text()).split('\n').entries()) {
      if (COMMENT_LINE.test(row))
        continue

      for (const match of row.matchAll(RAW_READ))
        found.push({ name: (match[1] ?? match[2])!, file: join(root, file), line: index + 1 })
    }
  }

  return found
}

function diagnostic(severity: 'error' | 'warning', file: string, line: number, message: string): CheckDiagnostic {
  return { file, line, column: 1, severity, message }
}

// What the declared variables, the compose files and the example env file say of each other, as problems: a variable production needs that no compose service sets, one the example lacks or has with nothing behind it, and a raw read of the environment no schema declares.
export async function compareEnv(root: string, variables: Listed[], files: EnvFiles): Promise<CheckDiagnostic[]> {
  const problems: CheckDiagnostic[] = []
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
        if (!declared.has(name) && !set.has(name) && !interpolated.has(name))
          problems.push(diagnostic('error', examplePath, line, `${name} is in ${relative(root, examplePath)} and no schema declares it${composeRead ? ', no compose service sets it and none interpolates it' : ''}`))
      }

      for (const variable of variables.filter(({ required, source }) => required !== false && source !== 'kay')) {
        if (!listed.has(variable.name) && set.get(variable.name)?.literal !== true)
          problems.push(diagnostic('error', examplePath, 1, `${variable.name} is required in production (${variable.source}) and ${relative(root, examplePath)} does not list it`))
      }
    }
  }

  for (const { name, file, line } of await rawReads(root)) {
    if (!declared.has(name) && !IGNORED_READS.has(name))
      problems.push(diagnostic('warning', file, line, `process.env.${name} is read with no schema declaring it: declare it with defineEnv so kay env lists it`))
  }

  return problems
}
