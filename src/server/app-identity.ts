import type { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { bundled } from './bundle'
import { query } from './pg-sql'

const IDENTITY = 'app'

// The name of the app running: the package.json name of its project, read from the one `kay build --compile` embedded in an executable. Nothing when there is none to read, which leaves a database unclaimed.
export function appName(): string | undefined {
  const embedded = bundled()

  if (embedded !== undefined)
    return embedded.name

  try {
    const { name } = JSON.parse(readFileSync(join(resolve(process.env.KAY_ROOT ?? process.cwd()), 'package.json'), 'utf8')) as { name?: unknown }

    return typeof name === 'string' && name !== '' ? name : undefined
  }
  catch {
    return undefined
  }
}

// What a boot refuses with when the database belongs to another app.
export class DatabaseOwnedError extends Error {}

// Records `name` in `kay_meta` as the app owning the database, the first app to boot claiming one that has none. Another app's boot throws, unless `KAY_ADOPT_DATABASE` names the owner it takes over from: the one-off way a renamed app keeps its data.
export async function claimDatabase(db: SQL, name: string | undefined, adopt = process.env.KAY_ADOPT_DATABASE): Promise<void> {
  if (name === undefined)
    return

  await query(db, 'INSERT INTO kay_meta (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [IDENTITY, name])

  const [row] = await query<{ value: string }>(db, 'SELECT value FROM kay_meta WHERE name = $1', [IDENTITY])
  const owner = row!.value

  if (owner === name)
    return

  if (adopt === owner) {
    await query(db, 'UPDATE kay_meta SET value = $1 WHERE name = $2 AND value = $3', [name, IDENTITY, owner])

    return
  }

  throw new DatabaseOwnedError(`kay: this database belongs to the app "${owner}", and "${name}" is starting on it, so they would share queues, cache, sessions, live values and rooms. Give "${name}" a database of its own. If "${name}" is "${owner}" renamed, start it once with KAY_ADOPT_DATABASE=${owner} to take the database over.`)
}
