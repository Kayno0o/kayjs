import { existsSync } from 'node:fs'
import process from 'node:process'
import { registerLoader } from '../server/loader'
import { testRoot } from './root'

// Listed under `[test] preload` in bunfig.toml, so test files can import `.kay` pages and their actions.
// The project is the working directory, or `KAY_ROOT` when it is nested, such as a library's fixture app.
const root = testRoot()

if (!existsSync(root))
  throw new Error(`kay: KAY_ROOT names ${process.env.KAY_ROOT}, and there is no such directory`)

await registerLoader(root)
