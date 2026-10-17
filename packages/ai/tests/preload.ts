import { resolve } from 'node:path'
import process from 'node:process'

// The tests serve the fixture app, which installs the library as an app does; absolute, as the unit tests run from the package's folder.
process.env.KAY_ROOT ??= resolve('tests/fixture')

await import('kay/test/preload')
