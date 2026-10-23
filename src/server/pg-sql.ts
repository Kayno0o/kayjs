import type { SQL } from 'bun'
import { rowsOf } from './pg-jobs'

// The database's clock in ms since the epoch, so replicas whose clocks disagree still share one window or one liveness.
export const NOW = 'floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint'

const ESCAPED = /\\(.)/g

// Postgres text holds no NUL, which a name made of a visitor's input may carry: it is stored as `\0`, a backslash doubled.
export const escaped = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\0', '\\0')
export const unescaped = (text: string): string => text.replace(ESCAPED, (_, char: string) => char === '0' ? '\0' : char)

// A query whose text carries the clock, its values `$1` on.
export async function query<Row>(db: SQL, text: string, values: (string | number | null | string[])[] = []): Promise<Row[]> {
  return rowsOf<Row>(db.unsafe(text, values))
}
