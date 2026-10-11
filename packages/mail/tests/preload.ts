import { resolve } from 'node:path'
import process from 'node:process'

// Test files import the fixture app's mails, compiled as that app compiles them, its settings and messages included; absolute, as the samples tests move into the fixture.
process.env.KAY_ROOT ??= resolve('tests/fixture')

await import('kay/test/preload')
