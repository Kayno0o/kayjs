// Run on a pseudo-terminal by tests/createUserCommand.test.ts: reads one secret as `kay auth create-user` does and says what it saw.
import { readFromTerminal } from '../../src/createUserCommand'

// A terminal that goes away hangs the process up; this one stays to see its input end.
process.on('SIGHUP', () => undefined)
process.on('exit', () => console.log(`exit raw=${process.stdin.isRaw}`))
console.log(`start raw=${process.stdin.isRaw}`)

const typed = await readFromTerminal('Password: ')

console.log(`typed=${typed === undefined ? 'nothing' : typed.length} raw=${process.stdin.isRaw}`)
