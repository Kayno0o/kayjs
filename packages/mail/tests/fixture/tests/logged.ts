type Level = 'info' | 'warn' | 'error'

const SINK = Symbol.for('kay.log')

// The lines kayjs-mail logs through kay's log sink while `run` runs, as `[level, 'kayjs-mail: message: what was thrown']`.
export async function logged(run: () => Promise<unknown>): Promise<[Level, string][]> {
  const lines: [Level, string][] = []
  const global = globalThis as { [SINK]?: unknown }
  const sink = global[SINK]

  global[SINK] = (level: Level, message: string, error?: unknown, _request?: Request, from?: string) => {
    if (from === 'kayjs-mail')
      lines.push([level, `${from}: ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}`])
  }

  try {
    await run()
  }
  finally {
    global[SINK] = sink
  }

  return lines
}
