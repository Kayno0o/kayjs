import process from 'node:process'

// The command a landing step runs: behind `slot`, the machine-wide limiter every session shares, so landings from several sessions queue instead of piling their workers and browsers on the same cores, and under `nice`, so the host's other work (a game server, a runner) takes the CPU first.
// A host without either runs the step as it is, and KAY_LAND_SLOT=0 or KAY_LAND_NICE=0 leaves that one out.
export function stepCommand(argv: string[], which: (name: string) => string | null = Bun.which, env: Record<string, string | undefined> = process.env) {
  const niceness = Number(env.KAY_LAND_NICE ?? 10)
  const command = [...argv]

  if (niceness > 0 && which('nice') !== null)
    command.unshift('nice', '-n', String(niceness))

  if (env.KAY_LAND_SLOT !== '0' && which('slot') !== null)
    command.unshift('slot', '--')

  return command
}
