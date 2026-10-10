export type LogLevel = 'info' | 'warn' | 'error'

// Where the server sends kay's messages, in the format its `log` option sets; read off the global so every copy of kay in the process shares it.
export type LogSink = (level: LogLevel, message: string, error?: unknown, request?: Request) => void

const SINK = Symbol.for('kay.log')
const CONSOLE = { info: 'log', warn: 'warn', error: 'error' } as const

// Logs one of kay's own messages: through the server's logger, else to the console as `[kay] ...`, which the dev problem panel picks up in the browser.
export function kayLog(level: LogLevel, message: string, error?: unknown): void {
  const sink = (globalThis as { [SINK]?: LogSink })[SINK]

  if (sink) {
    sink(level, message, error)

    return
  }

  if (error === undefined)
    console[CONSOLE[level]](`[kay] ${message}`)
  else
    console[CONSOLE[level]](`[kay] ${message}`, error)
}

export function setLogSink(sink: LogSink): void {
  (globalThis as { [SINK]?: LogSink })[SINK] = sink
}

export function logSink(): LogSink | undefined {
  return (globalThis as { [SINK]?: LogSink })[SINK]
}
