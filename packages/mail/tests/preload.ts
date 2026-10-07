import process from 'node:process'

// Test files import the fixture app's mails, compiled as that app compiles them, its settings included.
process.env.KAY_ROOT ??= 'tests/fixture'

await import('kay/test/preload')
