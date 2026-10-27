import { resolve } from 'node:path'
import process from 'node:process'

// The tests serve the fixture app, which installs the library as an app does; absolute, as the unit tests run from the package's folder.
process.env.KAY_ROOT ??= resolve('tests/fixture')

// The tests of the providers and of what `ask` does around one send to the provider they build, which `bun test` would answer from the fake.
process.env.KAYJS_AI_REAL_PROVIDERS = '1'

await import('kay/test/preload')
