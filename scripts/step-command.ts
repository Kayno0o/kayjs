import process from 'node:process'

type Which = (name: string) => string | null
type Env = Record<string, string | undefined>

// The command a landing step runs under `nice`, so the host's other work (a game server, a runner) takes the CPU first: KAY_LAND_NICE is its niceness, 0 leaves it out, and a host without `nice` runs the step as it is.
export function nicedCommand(argv: string[], which: Which = Bun.which, env: Env = process.env) {
  const niceness = Number(env.KAY_LAND_NICE ?? 10)

  return niceness > 0 && which('nice') !== null ? ['nice', '-n', String(niceness), ...argv] : argv
}

// What `slot`, the machine-wide limiter every session shares, runs before a command to hold a slot for it, so landings from several sessions queue instead of piling their workers and browsers on the same cores.
// A step with a lock holds that named lock alone, which only one holds at a time machine-wide, as the test runs do. None when `slot` is missing or KAY_LAND_SLOT=0.
export function slotPrefix(lock: string | undefined, which: Which = Bun.which, env: Env = process.env) {
  if (env.KAY_LAND_SLOT === '0' || which('slot') === null)
    return undefined

  return lock === undefined ? ['slot', '--'] : ['slot', '-l', lock, '--no-slot', '--']
}
