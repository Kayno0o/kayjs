import { isolateEnv } from './env'
import { testRoot } from './root'
import './natives'

// Listed under `[test] preload` in bunfig.toml, so test files can import `.kay` pages and their actions.
// The developer's own `.env` is dropped first, and kay's server code imported after, so no module reads it.
// The project is the working directory, or `KAY_ROOT` when it is nested, such as a library's fixture app.
isolateEnv()

const { registerLoader } = await import('../server/loader')

await registerLoader(testRoot())
