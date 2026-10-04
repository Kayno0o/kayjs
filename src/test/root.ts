import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

// The project tests serve: the working directory, or the one `KAY_ROOT` names when it is nested.
export function testRoot(root?: string): string {
  const dir = resolve(root ?? process.env.KAY_ROOT ?? process.cwd())

  if (!existsSync(dir))
    throw new Error(`kay: tests serve the project at ${dir}, and there is no such directory`)

  return dir
}
