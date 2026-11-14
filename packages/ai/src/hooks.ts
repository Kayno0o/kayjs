import type { BeforeHook, Hook, HookContext } from 'kay/library'
import type { AiToolCall, AskHooks, ErrorHookCall, FinishHookCall, Provider, RequestHookCall, RequestHookChange, Step } from './types'
import { configError, dispatch, hookContext, refuse } from 'kay/library'
import { answersAsFake } from './fake'

const SLOT = Symbol.for('kayjs-ai.hooks')
const NAMES = ['beforeRequest', 'afterStep', 'afterToolCall', 'afterRequest', 'onError'] as const

// The `on` names of 1.104 still work until 1.108: each is read where its `after` name is not written.
function settled(options: AskHooks): AskHooks {
  const { onStep, onToolCall, onSuccess, ...rest } = options

  return { ...rest, afterStep: rest.afterStep ?? onStep, afterToolCall: rest.afterToolCall ?? onToolCall, afterRequest: rest.afterRequest ?? onSuccess }
}

// The hooks an ask runs, each one's list in order: `ai()`'s first, then the ask's.
export interface Hooks {
  beforeRequest: readonly BeforeHook<RequestHookCall, RequestHookChange>[]
  afterStep: readonly Hook<Step>[]
  afterToolCall: readonly Hook<AiToolCall>[]
  afterRequest: readonly Hook<FinishHookCall>[]
  onError: readonly Hook<ErrorHookCall>[]
  // The request being answered, read when the ask is made: a reply may be read from outside it.
  context: Promise<HookContext> | undefined
}

export const NO_HOOKS: Hooks = { beforeRequest: [], afterStep: [], afterToolCall: [], afterRequest: [], onError: [], context: undefined }

// The hooks `ai()` set, on the global so every copy of the library in the process shares them.
function slot(): AskHooks {
  const holder = globalThis as { [SLOT]?: AskHooks }

  return holder[SLOT] ??= {}
}

// Called by `ai()`, which the app's config runs again on every reload: the hooks are replaced.
export function configureHooks(given: AskHooks): void {
  const options = settled(given)
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

function listed<Fn>(...hooks: (Fn | undefined)[]): Fn[] {
  return hooks.filter((hook): hook is Fn => hook !== undefined)
}

// The hooks an ask runs: those `ai()` set, then those named in its own options. The fake answering an ask is no real provider, so a hook set in `ai()` (a bill, an audit trail) is not run for it; one given to the ask itself is.
export function hooksFor(given: AskHooks, provider: Provider): Hooks {
  const options = settled(given)
  const set = slot()
  const fake = answersAsFake(provider)

  for (const name of NAMES) {
    const own: unknown = options[name]

    if (own !== undefined && typeof own !== 'function')
      throw configError('ai', name, `ask({ ${name} }) is a function`)
  }

  const global: AskHooks = fake ? {} : set
  const hooks = {
    beforeRequest: listed(global.beforeRequest, options.beforeRequest),
    afterStep: listed(global.afterStep, options.afterStep),
    afterToolCall: listed(global.afterToolCall, options.afterToolCall),
    afterRequest: listed(global.afterRequest, options.afterRequest),
    onError: listed(global.onError, options.onError),
  }

  const any = Object.values(hooks).some(list => list.length > 0)

  return { ...hooks, context: any ? hookContext() : undefined }
}

// Tells the hooks what happened, off the reply's path: a throw or a rejection is reported with source `ai.<hook>` and never turns into a failed reply.
export function tell<Event extends object>(name: string, hooks: readonly Hook<Event>[], event: Event, context: HookContext | undefined): void {
  // One dispatch each, so a hook that waits does not hold the next one back.
  for (const hook of hooks)
    void dispatch(`ai.${name}`, [hook], event, context === undefined ? { detached: true } : { detached: true, context })
}

// Runs `beforeRequest`: a throw refuses the ask, `false` refuses it with a 403, and the answers are the changes to the request, each hook seeing what the ones before changed.
export async function requested(hooks: readonly BeforeHook<RequestHookCall, RequestHookChange>[], call: RequestHookCall, context: HookContext): Promise<RequestHookChange | undefined> {
  let changes: RequestHookChange | undefined
  let current = call

  for (const hook of hooks) {
    const answer = await hook({ ...current, context })

    if (answer === false)
      refuse('The request was refused')

    if (answer === undefined)
      continue

    if (typeof answer !== 'object' || answer === null || Array.isArray(answer))
      throw configError('ai', 'beforeRequest', 'beforeRequest returns nothing, false, or { messages?, system? }')

    changes = { ...changes, ...answer }
    current = { ...current, ...answer.messages === undefined ? {} : { messages: answer.messages }, ...'system' in answer ? { system: answer.system } : {} }
  }

  return changes
}
