import type { SQL } from 'bun'
import { rowsOf } from './pg-jobs'

// The database's clock in ms since the epoch, so replicas whose clocks disagree still share one window or one liveness.
export const NOW = 'floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint'

// A query whose text carries the clock, its values `$1` on.
export async function query<Row>(db: SQL, text: string, values: (string | number | null)[] = []): Promise<Row[]> {
  return rowsOf<Row>(db.unsafe(text, values))
}
