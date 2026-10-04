import { resolve } from 'node:path'
import process from 'node:process'

// The project tests serve: the working directory, or the one `KAY_ROOT` names when it is nested.
export function testRoot(root?: string): string {
  return resolve(root ?? process.env.KAY_ROOT ?? process.cwd())
}
