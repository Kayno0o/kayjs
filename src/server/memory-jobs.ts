import type { JobStore, StoredJob } from './queue'
import { statusOf } from './job-status'
import { inMemory } from './memory-mark'

// Jobs kept in this process's memory, gone with it: what tests run on.
export function memoryJobs(): JobStore {
  const jobs = new Map<string, StoredJob & { failed?: boolean }>()
  const kept = new Map<string, string[]>()
  const locks = new Set<string>()
  const waiting = (queue: string) => [...jobs.values()].filter(job => job.queue === queue && !job.failed)
  const stored = ({ heldUntil: _, failed: __, ...job }: StoredJob & { failed?: boolean }): StoredJob => job
  // Whether a write about the job still comes from the run holding it: one that names no hold (a removal by id) always does.
  const holds = (job: StoredJob | undefined, until: number | undefined): job is StoredJob => job !== undefined && (until === undefined || job.heldUntil === until)

  return inMemory({
    add(job) {
      const holder = job.key === undefined ? undefined : waiting(job.queue).find(other => other.key === job.key)

      if (holder)
        return holder.id

      jobs.set(job.id, { ...job })

      return undefined
    },
    claim(queue, now, until) {
      const job = waiting(queue).filter(job => job.runAt <= now && (job.heldUntil ?? 0) <= now).sort((a, b) => a.runAt - b.runAt)[0]

      if (!job)
        return undefined

      job.heldUntil = until
      job.attempts++
      delete job.progress

      return { ...stored(job), heldUntil: until }
    },
    complete(id, until) {
      if (holds(jobs.get(id), until)) {
        jobs.delete(id)
        kept.delete(id)
      }
    },
    retry(id, runAt, error, until) {
      const job = jobs.get(id)

      if (!holds(job, until))
        return false

      Object.assign(job, { runAt, error, heldUntil: undefined })

      return true
    },
    release(id, until, runAt) {
      const job = jobs.get(id)

      if (job?.heldUntil === until) {
        delete job.heldUntil
        job.attempts--

        if (runAt !== undefined)
          job.runAt = runAt
      }
    },
    progress(id, until, progress) {
      const job = jobs.get(id)

      if (job?.heldUntil === until)
        job.progress = progress
    },
    update(id, change, guard) {
      const job = jobs.get(id)

      if (!job || job.failed)
        return false

      if ('until' in guard) {
        if (job.heldUntil !== guard.until)
          return false

        job.attempts = 1
      }
      else if ((job.heldUntil ?? 0) > guard.now || job.payload !== guard.payload) {
        return false
      }

      job.payload = change.payload

      if (change.runAt !== undefined)
        job.runAt = change.runAt

      if (change.steps) {
        const rows = kept.get(id) ?? []

        for (const [index, value] of change.steps.values.entries())
          rows[change.steps.from + index] = value

        kept.set(id, rows)
      }

      return true
    },
    steps(id) {
      return [...kept.get(id) ?? []]
    },
    state(queue, ref, now) {
      const matches = [...jobs.values()].filter(job => job.queue === queue && ('key' in ref ? job.key === ref.key : job.id === ref.id))
      const job = matches.find(other => !other.failed) ?? matches.filter(other => other.failed).sort((a, b) => b.runAt - a.runAt)[0]

      return job ? { ...stored(job), status: statusOf(job.failed === true, job.heldUntil ?? 0, now) } : undefined
    },
    live(queue, now, limit) {
      return waiting(queue).sort((a, b) => a.runAt - b.runAt).slice(0, limit).map(job => ({ ...stored(job), status: statusOf(false, job.heldUntil ?? 0, now) }))
    },
    fail(id, error, payload, until) {
      const job = jobs.get(id)

      if (!holds(job, until))
        return false

      Object.assign(job, { failed: true, error, heldUntil: undefined, ...payload !== undefined && { payload } })

      return true
    },
    prune(queue, before) {
      const purged = [...jobs.values()].filter(job => job.queue === queue && job.failed && job.runAt < before)

      for (const job of purged) {
        jobs.delete(job.id)
        kept.delete(job.id)
      }

      return purged.length
    },
    failed(queue, limit) {
      return [...jobs.values()].filter(job => job.queue === queue && job.failed).sort((a, b) => a.runAt - b.runAt).slice(0, limit).map(stored)
    },
    jobs(queue, options) {
      return [...jobs.values()].filter(job => job.queue === queue && (options?.failed === undefined || (job.failed === true) === options.failed)).sort((a, b) => a.runAt - b.runAt).slice(0, options?.limit).map(stored)
    },
    revive(id, runAt) {
      const job = jobs.get(id)

      if (!job?.failed || (job.key !== undefined && waiting(job.queue).some(other => other.key === job.key)))
        return false

      Object.assign(job, { failed: false, attempts: 0, runAt })
      delete job.heldUntil

      return true
    },
    nextRunAt(queue) {
      const times = waiting(queue).map(job => Math.max(job.runAt, job.heldUntil ?? 0))

      return times.length === 0 ? undefined : Math.min(...times)
    },
    lock(name, slot) {
      const key = `${name}\n${slot}`

      if (locks.has(key))
        return false

      locks.add(key)

      return true
    },
  })
}
