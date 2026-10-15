import type { KayConfig } from '../config'
import process from 'node:process'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'

// Writes the shadow tree of the project for `kay dev` from the config as it is now, in a process of its own so `kay dev` holds no checker and every module the config imports is read again.
const [root, entry] = process.argv.slice(2)

// A config that fails to load, halfway through an edit say, leaves the tree as it is; the server reports why.
async function currentConfig(): Promise<KayConfig | undefined> {
  try {
    return await loadConfig(root!, true)
  }
  catch {
    return undefined
  }
}

const config = await currentConfig()

if (config !== undefined) {
  try {
    await writeShadowTypes(root!, { ...configCheckOptions(config), entry: entry === '' ? undefined : entry })
  }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
