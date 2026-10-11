import * as kay from 'kay'

type Level = 'info' | 'warn' | 'error'

export type Log = Record<Level, (message: string, error?: unknown) => void>

// kay 1.37's `logFrom`, which sends a library's lines where the app's `log` setting sends kay's; read off the namespace, so an older kay without it still loads this library.
type LogFrom = (from: string) => Log

const LEVELS: Level[] = ['info', 'warn', 'error']

// Through kay's `logFrom` when the kay installed has one, else to the console as kayjs-mail always wrote, what was thrown said after the message.
export function libraryLog(logFrom: unknown): Log {
  if (typeof logFrom === 'function')
    return (logFrom as LogFrom)('kayjs-mail')

  return Object.fromEntries(LEVELS.map(level => [level, (message: string, error?: unknown) => {
    console[level](`kayjs-mail: ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}`)
  }])) as Log
}

export const log = libraryLog(Reflect.get(kay, 'logFrom'))
