import type { KayConfig } from '../config'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import process from 'node:process'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { ANSWER, CONFIG_REFUSED, ENTRY, LOAD, MODULES, REFUSE } from './refuse'

// Writes the shadow tree of the project for `kay dev` from the config as it is now, in a process of its own so `kay dev` holds no checker and every module the config imports is read again.
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

// What `kay dev` reads of a write: the modules loaded, then the exit code.
async function answer(line: string): Promise<void> {
  const code = await (line === LOAD ? load() : write())

  process.stdout.write(`\n${MODULES}${JSON.stringify(loadedModules())}\n\n${ANSWER}${code}\n`)
}

for await (const line of console) {
  if (line !== '')
    await answer(line)
}
