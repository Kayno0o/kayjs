import type { AskHooks, Provider, RequestHookCall, RequestHookChange } from './types'
import { logFrom } from 'kay'
import { configError } from 'kay/library'
import { answersAsFake } from './fake'

const SLOT = Symbol.for('kayjs-ai.hooks')
const NAMES = ['onRequest', 'onStep', 'onToolCall', 'onFinish', 'onError'] as const
const log = logFrom('kayjs-ai')

// The hooks `ai()` set, on the global so every copy of the library in the process shares them.
function slot(): AskHooks {
  const holder = globalThis as { [SLOT]?: AskHooks }

  return holder[SLOT] ??= {}
}

// Called by `ai()`, which the app's config runs again on every reload: the hooks are replaced.
export function configureHooks(options: AskHooks): void {
  const next: AskHooks = {}

  for (const name of NAMES) {
    const hook: unknown = options[name]

    if (hook === undefined)
      continue

    if (typeof hook !== 'function')
      throw configError('ai', name, `ai({ ${name} }) is a function`)

    Object.assign(next, { [name]: hook })
  }

  (globalThis as { [SLOT]?: AskHooks })[SLOT] = next
}

// The hooks an ask runs: each one named in its own options, else the one `ai()` set. The fake answering an ask is no real provider, so a hook set in `ai()` (a bill, an audit trail) is not run for it; one given to the ask itself is.
export function hooksFor(options: AskHooks, provider: Provider): AskHooks {
  const set = slot()
  const fake = answersAsFake(provider)
  const hooks: AskHooks = {}

  for (const name of NAMES) {
    const own: unknown = options[name]

    if (own !== undefined && typeof own !== 'function')
      throw configError('ai', name, `ask({ ${name} }) is a function`)

    const hook = own ?? (fake ? undefined : set[name])

    if (hook !== undefined)
      Object.assign(hooks, { [name]: hook })
  }

  return hooks
}

async function logged(pending: Promise<unknown>, name: string): Promise<void> {
  try {
    await pending
  }
  catch (error) {
    log.error(`${name} rejected`, error)
  }
}

// Tells a hook what happened, which a throw or a rejection of its own must not turn into a failed reply.
export function tell<Arg>(name: string, hook: ((arg: Arg) => unknown) | undefined, arg: Arg): void {
  if (hook === undefined)
    return

  try {
    const result = hook(arg)

    if (result instanceof Promise)
      void logged(result, name)
  }
  catch (error) {
    log.error(`${name} threw`, error)
  }
}

// Runs `onRequest`, whose throw refuses the ask and whose answer, when there is one, is the changes to the request.
export async function requested(hook: NonNullable<AskHooks['onRequest']>, call: RequestHookCall): Promise<RequestHookChange | undefined> {
  const change = await hook(call)

  if (change === undefined)
    return undefined

  if (typeof change !== 'object' || change === null || Array.isArray(change))
    throw configError('ai', 'onRequest', 'onRequest returns nothing, or { messages?, system? }')

  return change
}
