import { existsSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const STATE = '.eslintcache-state'
// Every folder with its own dependencies: the root, and the workspaces and apps below these.
const PROJECT_FILES = ['package.json', '*/package.json', 'bench/apps/*/package.json', 'packages/*/package.json', 'examples/*/package.json']

// What the types a lint reads depend on: each project's lockfile and the state of its `node_modules`, which an install changes, so a cached result made before it does not outlive it.
export async function installFingerprint(root: string): Promise<string> {
  const folders = new Set<string>()

  for (const pattern of PROJECT_FILES) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root }))
      folders.add(file.slice(0, -'package.json'.length))
  }

  const hasher = new Bun.CryptoHasher('sha256')

  for (const folder of [...folders].sort()) {
    const modules = join(root, folder, 'node_modules')
    const lock = Bun.file(join(root, folder, 'bun.lock'))

    hasher.update(`${folder}\0${existsSync(modules) ? statSync(modules).mtimeMs : '-'}\0${await lock.exists() ? await lock.text() : '-'}\0`)
  }

  return hasher.digest('hex')
}

// Drops every `.eslintcache*` of `root` when the install changed since they were written, and records the install the next lint runs against.
export async function dropStaleLintCache(root: string): Promise<boolean> {
  const current = await installFingerprint(root)
  const state = Bun.file(join(root, STATE))
  const stale = !await state.exists() || await state.text() !== current

  if (stale) {
    await Promise.all((await readdir(root)).filter(name => name.startsWith('.eslintcache') && name !== STATE).map(async name => rm(join(root, name), { force: true })))
    await Bun.write(state, current)
  }

  return stale
}
