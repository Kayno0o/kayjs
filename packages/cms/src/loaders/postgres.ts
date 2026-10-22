import type { PgLoaderOptions } from './pg'
import { pgLoader } from './pg'

export type { LoaderOptions, SeedEntry } from './shared'
export { pgLoader }
export type { PgLoaderOptions }

/** @deprecated Renamed `pgLoader` in 1.70, and its entry `@kaynooo/kayjs-cms/pg`, as every kayjs library says pg; the old name and entry go in 1.73. */
export const postgresLoader = pgLoader

/** @deprecated Renamed `PgLoaderOptions` in 1.70; the old name goes in 1.73. */
export type PostgresLoaderOptions = PgLoaderOptions
