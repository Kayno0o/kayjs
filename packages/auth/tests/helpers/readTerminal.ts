// Run on a pseudo-terminal by tests/createUserCommand.test.ts: reads one secret as `kay auth create-user` does and says what it saw.
import { readFromTerminal } from '../../src/createUserCommand'

// A terminal that goes away hangs the process up; this one stays to see its input end.
process.on('SIGHUP', () => undefined)
// Writing to a terminal that went away fails, which is no part of what is tested.
process.stdout.on('error', () => undefined)
process.stderr.on('error', () => undefined)
// No test run leaves this behind: a failure ends it, and so does the test that started it.
process.on('uncaughtException', () => process.exit(1))

const parent = process.ppid

setInterval(() => {
  if (process.ppid !== parent)
    process.exit(1)
}, 500).unref()
process.on('exit', () => console.log(`exit raw=${process.stdin.isRaw}`))
console.log(`start raw=${process.stdin.isRaw}`)

const typed = await readFromTerminal('Password: ')

console.log(`typed=${typed === undefined ? 'nothing' : typed.length} raw=${process.stdin.isRaw}`)
