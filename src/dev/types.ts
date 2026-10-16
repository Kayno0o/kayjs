import type { KayConfig } from '../config'
import process from 'node:process'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { ANSWER, CONFIG_REFUSED, REFUSE } from './refuse'

// Writes the shadow tree of the project for `kay dev` from the config as it is now, in a process of its own so `kay dev` holds no checker and every module the config imports is read again.
// It stays up between writes: each line `kay dev` sends writes the tree once more with the config this process loaded, and the line it answers with is the exit code that write would have had.
const [root, entry, refuse] = process.argv.slice(2)
let loaded: KayConfig | undefined

// A config that fails to load, halfway through an edit say, is reported and the tree written with the defaults, so the components keep their types; the server reports it too.
// It is tried again on the next write rather than kept.
async function currentConfig(): Promise<{ config: KayConfig, refused: boolean }> {
  if (loaded !== undefined)
    return { config: loaded, refused: false }

  try {
    loaded = await loadConfig(root!)

    return { config: loaded, refused: false }
  }
  catch (error) {
    console.error(error)

    return { config: {}, refused: refuse === REFUSE }
  }
}

async function write(): Promise<number> {
  try {
    const { config, refused } = await currentConfig()

    await writeShadowTypes(root!, { ...configCheckOptions(config), entry: entry === '' ? undefined : entry })

    return refused ? CONFIG_REFUSED : 0
  }
  catch (error) {
    console.error(error)

    return 1
  }
}

for await (const line of console) {
  if (line !== '')
    process.stdout.write(`\n${ANSWER}${await write()}\n`)
}
