import type { QueuedJob } from '../runtime/queue-jobs'
import type { JobStore, StoredJobState } from './queue'
import { parse } from 'devalue'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { readJobsWith } from '../runtime/queue-jobs'
import { encodeValue, unsendable } from '../runtime/wire'

// The most jobs a queue shows, the earliest due first, so a long queue is never read or sent whole.
const SHOWN_JOBS = 100

// How long a list read from the store stands for a render, and how often a process a tab follows the queue through reads it again: how it hears the jobs other processes add, take and finish.
export const RECHECK_MS = 1000
// How long the changes this process makes are gathered before its tabs' list is read again, so a burst of enqueues or progress reports costs one read.
export const GATHER_MS = 50

// What a job of a queue whose `live` is a function shows besides its payload, for the function to pick from.
export interface LiveJob {
  key?: string
  error?: string
  progress?: unknown
}

// What a queue's `live` gives a page: everything for `true`, else what the function returns of a job as its payload, beside its id, status, attempts and due time.
export type ShowJob = ((payload: unknown, job: LiveJob) => unknown) | undefined

interface Shown {
  name: string
  store: () => JobStore
  show: ShowJob
  // False once the queue was forgotten, a `kay dev` reload or a test: a render naming it is refused, and its tabs keep the list until it is declared again.
  declared: boolean
  jobs: QueuedJob[]
  // The list as a browser is sent it, which tells a list that changed from one read again the same.
  text: string
  // When the list was last read from the store, 0 once a change made here left it behind.
  readAt: number
  // Counts the changes made here, so a read that started before one does not stand for the list after it.
  changes: number
  reading: boolean
  again: boolean
  gathering: ReturnType<typeof setTimeout> | undefined
  // Whether the store failed at the last read, `show` at the last call or the list could not be sent, so each is logged once rather than at every read.
  down: boolean
  showFailed: boolean
  unsendable: boolean
  watchers: Set<() => void>
  timer: ReturnType<typeof setInterval> | undefined
}

const shown = new Map<string, Shown>()

// A job as its page reads it, or undefined for one whose `live` threw, which is left out rather than shown without what the page reads of it.
function view(entry: Shown, row: StoredJobState): QueuedJob | undefined {
  const base = { id: row.id, status: row.status === 'running' ? 'running' as const : 'waiting' as const, attempts: row.attempts, runAt: row.runAt }
  const job: LiveJob = {
    ...row.key !== undefined && { key: row.key },
    ...row.error !== undefined && { error: row.error },
    ...row.progress !== undefined && { progress: parse(row.progress) as unknown },
  }

  if (entry.show === undefined)
    return { ...base, ...job, payload: parse(row.payload) as unknown }

  try {
    return { ...base, payload: entry.show(parse(row.payload), job) }
  }
  catch (error) {
    if (!entry.showFailed)
      kayLog('error', `queue('${entry.name}')'s live threw, so the jobs it threw for are left out of its pages' list`, error)

    entry.showFailed = true

    return undefined
  }
}

// The waiting and running jobs of the queue: in one read from a store with `live`, else listed and asked one by one where they stand.
function listed(entry: Shown, now: number): StoredJobState[] | Promise<StoredJobState[]> {
  const store = entry.store()

  if (store.live)
    return store.live(entry.name, now, SHOWN_JOBS)

  if (!store.jobs)
    throw new KayError('config-invalid', `kay: queue('${entry.name}')'s store has neither live() nor jobs(), so its live option shows no job: add live() to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

  return listedOneByOne(store, entry.name, now)
}

async function listedOneByOne(store: JobStore, name: string, now: number): Promise<StoredJobState[]> {
  const found: StoredJobState[] = []

  for (const job of (await store.jobs!(name, { failed: false, limit: SHOWN_JOBS })).slice(0, SHOWN_JOBS)) {
    const state = store.state === undefined ? { ...job, status: 'waiting' as const } : await store.state(name, { id: job.id }, now)

    if (state !== undefined && state.status !== 'failed')
      found.push(state)
  }

  return found
}

function apply(entry: Shown, rows: StoredJobState[], at: number): void {
  entry.readAt = at

  if (entry.down)
    kayLog('info', `queue('${entry.name}') lists its jobs for live again`)

  entry.down = false

  const jobs = rows.filter(row => row.status !== 'failed').slice(0, SHOWN_JOBS).map(row => view(entry, row)).filter(job => job !== undefined)
  let text: string

  try {
    text = encodeValue(jobs)
  }
  catch (error) {
    if (!entry.unsendable)
      kayLog('error', `queue('${entry.name}')'s live gives what a browser cannot be sent${unsendable(error) === undefined ? '' : ` (${unsendable(error)})`}, so the list its pages show is left as it was`, error)

    entry.unsendable = true

    return
  }

  entry.unsendable = false

  if (text === entry.text)
    return

  entry.jobs = jobs
  entry.text = text

  for (const notify of entry.watchers)
    notify()
}

function failed(entry: Shown, error: unknown): void {
  if (!entry.down)
    kayLog('error', `queue('${entry.name}') could not list its jobs for live, so its pages show them as they were; it reads them again at the next change or look`, error)

  entry.down = true
}

// Reads the list again, at once from a store that answers synchronously; a read asked for while one is in flight runs once it lands. It never throws, as a change of the store calls it once the change is made.
function refresh(entry: Shown): void {
  if (entry.reading) {
    entry.again = true

    return
  }

  const at = Date.now()

  try {
    const rows = listed(entry, at)

    if (rows instanceof Promise) {
      void refreshLater(entry, rows, at)

      return
    }

    apply(entry, rows, at)
  }
  catch (error) {
    failed(entry, error)
  }
}

async function refreshLater(entry: Shown, rows: Promise<StoredJobState[]>, at: number): Promise<void> {
  const changes = entry.changes

  entry.reading = true

  try {
    apply(entry, await rows, at)
  }
  catch (error) {
    failed(entry, error)
  }
  finally {
    entry.reading = false
  }

  // A change made here during the read is not in what it found: read once more.
  if (entry.changes !== changes) {
    entry.readAt = 0
    entry.again = true
  }

  if (entry.again) {
    entry.again = false
    refresh(entry)
  }
}

// Declares a queue's jobs shown to islands, its store read through `store` and each job through `show`. Gives what the queue tells of a change it made, and what reads the list at the server's start.
export function showJobs(name: string, store: () => JobStore, show: ShowJob): { changed: () => void, read: () => void } {
  let entry = shown.get(name)

  // A queue declared again (a `kay dev` reload) keeps its list and the tabs following it.
  if (entry === undefined)
    shown.set(name, entry = { name, store, show, declared: true, jobs: [], text: encodeValue([]), readAt: 0, changes: 0, reading: false, again: false, gathering: undefined, down: false, showFailed: false, unsendable: false, watchers: new Set(), timer: undefined })
  else
    Object.assign(entry, { store, show, declared: true, readAt: 0, showFailed: false, unsendable: false })

  const held = entry

  return {
    // The next render reads the list again; the tabs following it here get it once the changes of the moment are gathered.
    changed: () => {
      held.changes++
      held.readAt = 0

      if (held.watchers.size === 0 || held.gathering !== undefined)
        return

      held.gathering = setTimeout(() => {
        held.gathering = undefined
        refresh(held)
      }, GATHER_MS)
      held.gathering.unref()
    },
    read: () => refresh(held),
  }
}

export function forgetShownJobs(name: string): void {
  const entry = shown.get(name)

  if (entry !== undefined)
    entry.declared = false
}

function declared(name: string): Shown | undefined {
  const entry = shown.get(name)

  return entry?.declared === true ? entry : undefined
}

// A store answering synchronously is read before the render goes on; one over a network gives the list as last read, which the page's connection brings up to date.
readJobsWith((name) => {
  const entry = declared(name)

  if (entry === undefined)
    throw new KayError('config-invalid', `kay: jobs('${name}') names no queue declared with \`live\` in this server: give queue('${name}', handler, { live: true }) the option, and import its module in the server`)

  if (!entry.reading && Date.now() - entry.readAt >= RECHECK_MS)
    refresh(entry)

  return entry.jobs
})

// What a connection watching a queue's jobs sends: the list as this process holds it, a changed one after calling `notify`. While any tab watches, the list is read again every second, which is how a job another process took or finished reaches it.
export function jobsEntry(name: string): { value: () => QueuedJob[], watch: (notify: () => void) => () => void } | undefined {
  const entry = declared(name)

  if (entry === undefined)
    return undefined

  return {
    value: () => entry.jobs,
    watch(notify) {
      entry.watchers.add(notify)

      if (entry.timer === undefined) {
        entry.timer = setInterval(() => {
          if (entry.declared)
            refresh(entry)
        }, RECHECK_MS)
        entry.timer.unref()
      }

      if (Date.now() - entry.readAt >= RECHECK_MS)
        refresh(entry)

      return () => {
        entry.watchers.delete(notify)

        if (entry.watchers.size > 0)
          return

        clearInterval(entry.timer)
        entry.timer = undefined
      }
    },
  }
}
