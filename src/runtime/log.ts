export type LogLevel = 'info' | 'warn' | 'error'

// Where the server sends kay's messages, in the format its `log` option sets; read off the global so every copy of kay in the process shares it.
// `from` names who logs, kay or a library, and comes last so a sink set by another version of kay takes a call from this one.
export type LogSink = (level: LogLevel, message: string, error?: unknown, request?: Request, from?: string) => void

// What `logFrom` gives a library: a function per level, taking the message and what was thrown, if anything.
export type Log = Record<LogLevel, (message: string, error?: unknown) => void>

const SINK = Symbol.for('kay.log')
const CONSOLE = { info: 'log', warn: 'warn', error: 'error' } as const

// Logs one of kay's own messages: through the server's logger, else to the console as `[kay] ...`, which the dev problem panel picks up in the browser.
export function kayLog(level: LogLevel, message: string, error?: unknown): void {
  write(level, message, error, 'kay')
}

// A library's log, `from` heading its messages where kay's would say kay: they go where the app's `log` option sends kay's, under the request being answered.
export function logFrom(from: string): Log {
  if (from === '')
    throw new TypeError('kay: logFrom takes the name heading the library\'s messages, such as logFrom(\'kayjs-mail\')')

  return {
    info: (message, error) => write('info', message, error, from),
    warn: (message, error) => write('warn', message, error, from),
    error: (message, error) => write('error', message, error, from),
  }
}

function write(level: LogLevel, message: string, error: unknown, from: string) {
  const sink = (globalThis as { [SINK]?: LogSink })[SINK]

  if (sink) {
    sink(level, message, error, undefined, from)

    return
  }

  if (error === undefined)
    console[CONSOLE[level]](`[${from}] ${message}`)
  else
    console[CONSOLE[level]](`[${from}] ${message}`, error)
}

export function setLogSink(sink: LogSink): void {
  (globalThis as { [SINK]?: LogSink })[SINK] = sink
}

export function logSink(): LogSink | undefined {
  return (globalThis as { [SINK]?: LogSink })[SINK]
}
