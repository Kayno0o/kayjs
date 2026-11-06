import type { ErrorShape } from '../runtime/api-error'
import { within } from '@kaynooo/utils/promise'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { thrownRefusal } from '../runtime/refuse'
import { requestOfContext } from './log'
import { knownAddress } from './protection'
import { insideJob, trackDetached } from './queue-scheduler'
import { reportHookError } from './report'
import { userOf } from './request-user'

// What every hook of kay and its libraries is told about where it runs; a library extends it with what it knows.
export interface HookContext {
  // The request being answered, undefined in a job, a schedule or a prune.
  request: Request | undefined
  ip: string | undefined
  userAgent: string | undefined
  // Who the libraries named the request's user, as `userOf` answers.
  userId: string | undefined
  locale: string | undefined
}

// An `onX` hook: told what happened, its return ignored.
export type Hook<E> = (event: E & { context: HookContext }) => unknown

// A `beforeX` hook: nothing goes on unchanged, an object lays the fields it may change over the input, `false` refuses, and throwing `refuse()` refuses with a message.
export type BeforeHook<E, Change> = (event: E & { context: HookContext }) => void | false | Partial<Change> | Promise<void | false | Partial<Change>>

export interface DispatchOptions {
  // Runs the hooks off the caller's path: not awaited, for a streaming answer or a timing-sensitive one.
  detached?: boolean | undefined
  // The context to hand the hooks, for a caller that built it already; read from the request being answered otherwise.
  context?: HookContext | undefined
}

// How long a hook is waited for: it is left running after, and the late finish is reported.
const HOOK_TIMEOUT_MS = 10_000

// The context of the request this async context was started for, with empty fields outside one.
export async function hookContext(): Promise<HookContext> {
  // A job belongs to no request: its runs start outside any, and a hook of one run another way is told so too.
  const request = insideJob() ? undefined : requestOfContext()
  const locale = insideJob() ? undefined : localeState()?.locale

  if (request === undefined)
    return { request, ip: undefined, userAgent: undefined, userId: undefined, locale }

  let userId: string | undefined
  let ip: string | undefined

  // A library naming the user badly, or an address that cannot be read, must not stop a hook from running.
  try {
    userId = await userOf(request)
  }
  catch (error) {
    kayLog('warn', 'a library naming the request\'s user failed, the hook runs without it', error)
  }

  try {
    ip = knownAddress(request, undefined)
  }
  catch (error) {
    kayLog('warn', 'the request\'s address could not be read, the hook runs without it', error)
  }

  return { request, ip, userAgent: request.headers.get('user-agent') ?? undefined, userId, locale }
}

type Outcome = { failed: false } | { failed: true, error: unknown }

async function attempt(run: () => unknown): Promise<Outcome> {
  try {
    await run()

    return { failed: false }
  }
  catch (error) {
    return { failed: true, error }
  }
}

// Reports a hook that failed after it was left running.
async function reportLate(source: string, outcome: Promise<Outcome>, context: HookContext): Promise<void> {
  const done = await outcome

  if (done.failed)
    await reportHookError(source, done.error, context.request)
}

async function runHooks<E extends object>(source: string, hooks: readonly (Hook<E> | undefined)[], event: E, given: HookContext | undefined): Promise<void> {
  const context = given ?? await hookContext()
  const told = { ...event, context }

  for (const hook of hooks) {
    if (hook === undefined)
      continue

    const outcome = attempt(() => hook(told))
    const done = await within(outcome, HOOK_TIMEOUT_MS, 'late' as const)

    if (done === 'late') {
      await reportHookError(source, new Error(`${source} did not finish in ${HOOK_TIMEOUT_MS} ms, left running`), context.request)
      trackDetached(reportLate(source, outcome, context))
    }
    else if (done.failed) {
      await reportHookError(source, done.error, context.request)
    }
  }
}

// Tells the `onX` hooks of one transition, in order: each is awaited for up to 10 s, a throw or a late finish is logged and handed to the app's `onError` with `source`, and the next hook still runs.
// Never rejects.
export async function dispatch<E extends object>(source: string, hooks: readonly (Hook<E> | undefined)[], event: E, { detached = false, context }: DispatchOptions = {}): Promise<void> {
  if (!hooks.some(hook => hook !== undefined))
    return

  const run = runHooks(source, hooks, event, context)

  if (detached)
    trackDetached(run)
  else
    await run
}

const LATE = Symbol('late')

// Runs the `beforeX` hooks of one transition in order: each sees the event with what the ones before changed, the first refusal stops the chain, and a throw other than `refuse()` refuses as a server error after it is reported.
export async function decide<E extends object, C extends object>(source: string, hooks: readonly (BeforeHook<E, C> | undefined)[], event: E, given?: HookContext): Promise<{ change: Partial<C> } | { refused: ErrorShape & { retryAfter?: number | undefined } }> {
  if (!hooks.some(hook => hook !== undefined))
    return { change: {} }

  const context = given ?? await hookContext()
  let change: Partial<C> = {}

  for (const hook of hooks) {
    if (hook === undefined)
      continue

    let answer: void | false | Partial<C>

    try {
      // A check that does not finish refuses, as one that throws does: it never lets a change through unchecked.
      const done = await within(Promise.resolve(hook({ ...event, ...change, context })), HOOK_TIMEOUT_MS, LATE)

      if (done === LATE)
        throw new Error(`${source} did not finish in ${HOOK_TIMEOUT_MS} ms`)

      answer = done
    }
    catch (error) {
      const refusal = thrownRefusal(error)

      if (refusal !== undefined)
        return { refused: refusal }

      await reportHookError(source, error, context.request)

      return { refused: { status: 500, message: 'Internal server error', errors: {}, data: undefined } }
    }

    if (answer === false)
      return { refused: { status: 403, message: 'Refused', errors: {}, data: undefined } }

    if (typeof answer === 'object' && answer !== null && !Array.isArray(answer))
      change = { ...change, ...answer }
  }

  return { change }
}
