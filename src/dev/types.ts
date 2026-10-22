import type { ProbeMemory } from '../check'
import type { KayConfig } from '../config'
import type { TypeProblem } from './refuse'
import { readFileSync, realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import process from 'node:process'
import { check, configCheckOptions, formatCheckDiagnostic, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { ANSWER, CHECK, CHECK_SKIPPED, CONFIG_REFUSED, ENTRY, LOAD, MODULES, PROBLEMS, REFUSE } from './refuse'

// Writes the shadow tree of the project for `kay dev`, or types the project as `kay check` does, from the config as it is now, in a process of its own so `kay dev` holds no checker and every module the config imports is read again.
// It stays up between writes: each line `kay dev` sends but `load` writes the tree once more with the config this process loaded, and the line it answers with is the exit code that write would have had.
const [root, entry, refuse] = process.argv.slice(2)
let loaded: KayConfig | undefined
// The `load` before this write reported why the config does not load, so the write that tries again stays quiet about it.
let reported = false

// A config that fails to load, halfway through an edit say, is reported and the tree written with the defaults, so the components keep their types; the server reports it too.
// It is tried again on the next write rather than kept.
async function currentConfig(quiet = false): Promise<{ config: KayConfig, refused: boolean }> {
  if (loaded !== undefined)
    return { config: loaded, refused: false }

  try {
    loaded = await loadConfig(root!)

    return { config: loaded, refused: false }
  }
  catch (error) {
    if (!quiet)
      console.error(error)

    return { config: {}, refused: refuse === REFUSE }
  }
}

// The project's own modules the config and the writes loaded, which a change to needs a new process.
function loadedModules(): string[] {
  const project = realpathSync(root!) + sep

  return Object.keys(require.cache).filter(path => path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`))
}

// Reads the config alone, which is all the first server waits for.
async function load(): Promise<number> {
  const { config, refused } = await currentConfig()

  reported = loaded === undefined

  if (!refused)
    process.stdout.write(`\n${ENTRY}${projectPaths(root!, { ...config, entry: entry === '' ? config.entry : entry }).entry}\n`)

  return refused ? CONFIG_REFUSED : 0
}

async function write(): Promise<number> {
  try {
    const quiet = reported

    reported = false

    const { config, refused } = await currentConfig(quiet)

    const named = entry === '' ? config.entry : entry

    await writeShadowTypes(root!, { ...configCheckOptions(config), entry: named, typesOnly: true })

    if (!refused)
      process.stdout.write(`\n${ENTRY}${projectPaths(root!, { ...config, entry: named }).entry}\n`)

    return refused ? CONFIG_REFUSED : 0
  }
  catch (error) {
    console.error(error)

    return 1
  }
}

// The collections and messages the checks read, kept between them as `kay check --watch` does: read again only when a file they read changed.
const probes: ProbeMemory = new Map()
// The diagnostics tsgo reported, with or without a code of its own, and the lints made of its errors: the other lints `kay check` finds in the .kay files are the dev tool's already, from the compile.
const TYPE_CODE = /^TS\d+$/
// The lints only the types find, which the compile does not report.
const TYPE_LINTS = new Set(['uncalled-signal', 'island-action', 'secret-prop', 'incomplete-match'])

// Types the project as `kay check` does, with the config this process loaded, and says the type errors on a line of their own.
async function typecheck(): Promise<number> {
  try {
    const { config, refused } = await currentConfig(true)

    // A config that does not load would be checked against defaults, whose errors are noise: the last result stays.
    if (loaded === undefined || refused)
      return CHECK_SKIPPED

    const found = (await check(root!, { ...configCheckOptions(config), entry: entry === '' ? config.entry : entry }, probes)).filter(({ code }) => code === undefined || TYPE_CODE.test(code) || TYPE_LINTS.has(code))
    const problems = found.map((diagnostic): TypeProblem => {
      const source = readText(diagnostic.file)

      return { file: relative(root!, diagnostic.file), line: diagnostic.line, column: diagnostic.column, code: diagnostic.code, message: diagnostic.message, report: formatCheckDiagnostic(diagnostic, source) }
    })

    process.stdout.write(`\n${PROBLEMS}${JSON.stringify(problems)}\n`)

    return Number(problems.length > 0)
  }
  catch (error) {
    console.error(error)

    return CHECK_SKIPPED
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }
}

const COMMANDS: Record<string, () => Promise<number>> = { [LOAD]: load, [CHECK]: typecheck }

// What `kay dev` reads of a write: the modules loaded, then the exit code.
async function answer(line: string): Promise<void> {
  const code = await (COMMANDS[line] ?? write)()

  process.stdout.write(`\n${MODULES}${JSON.stringify(loadedModules())}\n\n${ANSWER}${code}\n`)
}

// The answers run one at a time, apart from the loop reading stdin, which sees it close while a check runs.
let turn: Promise<void> = Promise.resolve()

for await (const line of console) {
  if (line !== '') {
    const previous = turn

    turn = (async () => {
      await previous
      await answer(line)
    })()
  }
}

// `kay dev` is gone, however it ended, and a group of its own no longer gets the terminal's signals: this one ends whole, the checker it spawned with it.
try {
  process.kill(-process.pid, 'SIGKILL')
}
catch {
  process.exit(0)
}
