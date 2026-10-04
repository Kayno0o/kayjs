import { registerLoader } from '../server/loader'
import { testRoot } from './root'

// Listed under `[test] preload` in bunfig.toml, so test files can import `.kay` pages and their actions.
// The project is the working directory, or `KAY_ROOT` when it is nested, such as a library's fixture app.
await registerLoader(testRoot())
