import { defineTable } from '@kaynooo/pg-orm'

// The job queue's tables as pg-orm definitions, matching what `createJobTables` creates: list `jobTables` in the app's `new Database({ tables })` and its own migrations create them, which `pgJobs` then finds.
export const KayJobs = defineTable('kay_jobs', t => ({
  id: t.text().primaryKey(),
  queue: t.text().notNull(),
  payload: t.text().notNull(),
  attempts: t.int4().notNull(),
  run_at: t.int8().notNull(),
  held_until: t.int8().nullable(),
  failed: t.bool().notNull().default(false),
  error: t.text().nullable(),
  job_key: t.text().nullable(),
  progress: t.text().nullable(),
})).withIndexes([
  { name: 'kay_jobs_due', columns: ['queue', 'failed', 'run_at'] },
  // A live job holds its key: the key is free again once the job completed or was kept as failed.
  { name: 'kay_jobs_key', columns: ['queue', 'job_key'], unique: true, where: 'job_key IS NOT NULL AND NOT failed' },
])

export const KayLocks = defineTable('kay_locks', t => ({
  name: t.text().primaryKey(),
  slot: t.int8().primaryKey(),
}))

export const jobTables = [KayJobs, KayLocks] as const
