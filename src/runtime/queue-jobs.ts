import { live } from './live-value'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// The id the jobs of the queues declared with `live` are known by on the live connection: one keyed value, whose key is the queue's name.
export const JOBS_LIVE_ID = 'kay:jobs'

// A waiting or running job of a queue declared with `live`, as an island reads it.
export interface QueuedJob<Payload = unknown, Progress = unknown> {
  id: string
  // What the job was enqueued under, when it has a key.
  key?: string
  // `running` while a process holds it, `waiting` for a job due, delayed or waiting for a retry.
  status: 'waiting' | 'running'
  // Runs started so far, the one going on included.
  attempts: number
  // When it is due, in ms since the epoch.
  runAt: number
  // Why its last run failed, for a job waiting for a retry.
  error?: string
  // What its run last reported.
  progress?: Progress
  // The payload, or what the queue's `live` gives of it.
  payload: Payload
}

type Read = (queue: string) => QueuedJob[]

let handle: Read | undefined
let readJobs: Read | undefined

// Installed by the server: the jobs a queue shows now, for the render to write into the page.
export function readJobsWith(read: Read): void {
  readJobs = read
}

// The waiting and running jobs of a queue declared with `live`, earliest due first, in an island: `jobs<{ target: string }>('scans')` follows them as jobs are added, taken, done or failed, in every process.
// The page proves the queue it read as it does any live value, so whoever may render the page may follow it.
export function jobs<Payload = unknown, Progress = unknown>(queue: string): QueuedJob<Payload, Progress>[] {
  handle ??= (live as (initial: Read, id: string, name: string) => Read)((name: string) => {
    if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' && readJobs === undefined)
      throw new Error(`kay: jobs('${name}') names no queue declared with \`live\`: give queue('${name}', handler, { live: true }) the option, and import its module in the server`)

    return readJobs?.(name) ?? []
  }, JOBS_LIVE_ID, 'jobs')

  return handle(queue) as QueuedJob<Payload, Progress>[]
}
