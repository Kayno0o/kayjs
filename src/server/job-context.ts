import type { Locale } from '../runtime/i18n'
import type { Log } from '../runtime/log'
import { siteDefaultLocale } from '../runtime/locale-state'

// The run a handler is in: which job it is, how often it started and how it reports.
export interface JobRef<Progress> {
  id: string
  // Runs started so far, this one included.
  attempts: number
  // Reports how far the run is, any value devalue keeps, for `job()` to read back while it runs and after it fails; the latest report wins, written in the background, and a report after the run ended is dropped.
  progress: (value: Progress) => void
}

// What every job handler gets after its input, a queue's, a workflow's, a schedule's or a background job's: `(input, ctx)`.
export interface JobContext<Progress = unknown> {
  // Aborts when the run outlasts its `timeout` or the server stops.
  signal: AbortSignal
  job: JobRef<Progress>
  // Logs through the server's logger under the job's name.
  log: Log
  // The site's default locale, which the formatters read where no request runs.
  locale: Locale
}

// The context of a run as the handler is handed it.
export function runContext<Progress>(signal: AbortSignal, job: JobRef<Progress>, log: Log): JobContext<Progress> {
  // `Locale` is the app's registered locales where the app declares them, which `siteDefaultLocale()`'s string is not.
  // eslint-disable-next-line ts/no-unnecessary-type-assertion
  return { signal, job, log, locale: siteDefaultLocale() as Locale }
}

// What a run that outlasted its `timeout` fails with, in milliseconds below a second.
export function lostAfterText(milliseconds: number): string {
  return `it ran past its timeout, ${milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${Math.round(milliseconds / 1000)} s`}`
}
