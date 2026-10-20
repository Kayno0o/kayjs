import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { version } from '../../package.json'
import { fileStamp, stampTime, writeAtomically } from '../build/files'
import { CONFIG_FILE } from '../config'

// Written beside the client build once the process writing the types has loaded the config: what a later start needs of that load, so its first server need not wait for the load to be told the entry or that the config loads.
const CONFIG_RECORD = 'config.json'
// A file written this close to the load may share its stamp with a write made while the config was read.
const SETTLED_MS = 2000
const ROOT_FILES = [CONFIG_FILE, 'package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'tsconfig.json']
const ENV_FILE = /^\.env/

interface ConfigStamps {
  identity: string
  entry: string
  stamps: Record<string, string>
}

function identity(): string {
  return `${version}\0${Bun.version}`
}

// The root files Bun reads before it runs the config, with the names of the `.env` files there are.
function rootFiles(root: string): string[] {
  try {
    return [...new Set([...ROOT_FILES, ...readdirSync(root).filter(name => ENV_FILE.test(name))])].map(name => join(root, name))
  }
  catch {
    return ROOT_FILES.map(name => join(root, name))
  }
}

// The server entry the config named when it last loaded, while it, the modules it imported and the files Bun reads on its way are as they were. The environment is not looked at: the types that load the config again tell if it no longer loads.
export async function readConfigRecord(output: string, root: string): Promise<string | undefined> {
  try {
    const saved = await Bun.file(join(output, CONFIG_RECORD)).json() as ConfigStamps
    const known = new Set(Object.keys(saved.stamps))

    if (saved.identity !== identity() || rootFiles(realpathSync(root)).some(file => !known.has(file)))
      return undefined

    return Object.entries(saved.stamps).every(([file, stamp]) => (fileStamp(file) ?? '') === stamp) ? saved.entry : undefined
  }
  catch {
    return undefined
  }
}

// `loadedAt` is when the load began: a file written since, or just before, may have been read half done, and leaves no record.
export async function writeConfigRecord(output: string, root: string, entry: string, modules: string[], loadedAt: number): Promise<void> {
  const stamps: Record<string, string> = {}

  for (const file of [...modules, ...rootFiles(realpathSync(root))]) {
    const stamp = fileStamp(file) ?? ''

    if (stamp !== '' && stampTime(stamp) >= loadedAt - SETTLED_MS)
      return

    stamps[file] = stamp
  }

  try {
    await writeAtomically(join(output, CONFIG_RECORD), JSON.stringify({ identity: identity(), entry, stamps } satisfies ConfigStamps))
  }
  catch {}
}
