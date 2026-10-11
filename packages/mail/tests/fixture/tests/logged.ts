import { spyOn } from 'bun:test'

type Level = 'info' | 'warn' | 'error'

const SINK = Symbol.for('kay.log')
const LEVELS: Level[] = ['info', 'warn', 'error']

// The lines kayjs-mail logs while `run` runs, as `[level, 'kayjs-mail: message: what was thrown']`, whether they go through kay's log sink, with a kay that has `logFrom`, or to the console, with one that has not.
export async function logged(run: () => Promise<unknown>): Promise<[Level, string][]> {
  const lines: [Level, string][] = []
  const global = globalThis as { [SINK]?: unknown }
  const sink = global[SINK]

  global[SINK] = (level: Level, message: string, error?: unknown, _request?: Request, from?: string) => {
    if (from === 'kayjs-mail')
      lines.push([level, `${from}: ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}`])
  }

  const spies = LEVELS.map(level => spyOn(console, level).mockImplementation((line: unknown) => {
    if (typeof line === 'string' && line.startsWith('kayjs-mail: '))
      lines.push([level, line])
  }))

  try {
    await run()
  }
  finally {
    global[SINK] = sink

    for (const spy of spies)
      spy.mockRestore()
  }

  return lines
}
