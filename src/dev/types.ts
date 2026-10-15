import type { KayConfig } from '../config'
import process from 'node:process'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { CONFIG_REFUSED, REFUSE } from './refuse'

// Writes the shadow tree of the project for `kay dev` from the config as it is now, in a process of its own so `kay dev` holds no checker and every module the config imports is read again.
const [root, entry, refuse] = process.argv.slice(2)

// A config that fails to load, halfway through an edit say, is reported and the tree written with the defaults, so the components keep their types; the server reports it too.
async function currentConfig(): Promise<KayConfig> {
  try {
    return await loadConfig(root!)
  }
  catch (error) {
    console.error(error)

    if (refuse === REFUSE)
      process.exitCode = CONFIG_REFUSED

    return {}
  }
}

try {
  await writeShadowTypes(root!, { ...configCheckOptions(await currentConfig()), entry: entry === '' ? undefined : entry })
}
catch (error) {
  console.error(error)
  process.exitCode = 1
}
