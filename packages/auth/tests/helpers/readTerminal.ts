// Run on a pseudo-terminal by tests/createUserCommand.test.ts: reads one secret as `kay auth create-user` does and says what it saw.
import { readFromTerminal } from '../../src/createUserCommand'

const parent = process.ppid

// A terminal that goes away hangs the process up; this one stays to see its input end.
process.on('SIGHUP', () => undefined)
// Writing to a terminal that went away fails, which is no part of what is tested.
process.stdout.on('error', () => undefined)
process.stderr.on('error', () => undefined)
// An error ends the helper, said on stdout so the test shows it.
process.on('uncaughtException', (error) => {
  console.log(`failed ${error}`)
  process.exit(1)
})

// The test that started it is gone when its parent changes: nothing is left to read its output.
setInterval(() => {
  if (process.ppid !== parent)
    process.exit(1)
}, 500).unref()

process.on('exit', () => console.log(`exit raw=${process.stdin.isRaw}`))
console.log(`start raw=${process.stdin.isRaw}`)

const typed = await readFromTerminal('Password: ')

console.log(`typed=${typed === undefined ? 'nothing' : typed.length} raw=${process.stdin.isRaw}`)
