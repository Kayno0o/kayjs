import process from 'node:process'
import { registerLoader } from '../server/loader'

// Listed under `[test] preload` in bunfig.toml, so test files can import `.kay` pages and their actions.
await registerLoader(process.cwd())
