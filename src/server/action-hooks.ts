import type { TSchema } from 'elysia'
import type { ActionsConfig } from '../config'
import type { ActionDone, ActionFailed, ActionHooks, ActionRun, ServerAction } from '../runtime/action'
import type { ErrorShape } from '../runtime/api-error'
import type { BeforeHook, Hook } from './hooks'
import { resolveProtection } from '../runtime/action-protection'
import { decide, notify } from './hooks'

// The hooks of one action in the order they run: the app's, then the action's own.
export interface ActionHookLists {
  before: BeforeHook<ActionRun, never>[]
  success: Hook<ActionDone>[]
  error: Hook<ActionFailed>[]
}

const NONE: ActionHookLists = { before: [], success: [], error: [] }

function listed<T>(app: T | undefined, own: T | undefined): T[] {
  return [app, own].filter((hook): hook is T => hook !== undefined)
}

export function hooksOf(app: ActionHooks | undefined, own: ActionHooks | undefined): ActionHookLists {
  if (app === undefined && own === undefined)
    return NONE

  return { before: listed(app?.beforeRun, own?.beforeRun), success: listed(app?.onSuccess, own?.onSuccess), error: listed(app?.onError, own?.onError) }
}

export function hasHooks(lists: ActionHookLists): boolean {
  return lists.before.length + lists.success.length + lists.error.length > 0
}

// The `beforeRun` hooks of a run: the refusal when one stops it.
export async function refusedBeforeRun(lists: ActionHookLists, event: ActionRun): Promise<(ErrorShape & { retryAfter?: number | undefined }) | undefined> {
  if (lists.before.length === 0)
    return undefined

  const answer = await decide('actions.beforeRun', lists.before, event)

  return 'refused' in answer ? answer.refused : undefined
}

export async function tellSuccess(lists: ActionHookLists, event: ActionRun, result: unknown): Promise<void> {
  if (lists.success.length > 0)
    await notify('actions.onSuccess', lists.success, { ...event, result })
}

export async function tellError(lists: ActionHookLists, event: ActionRun, failure: Pick<ActionFailed, 'status' | 'message' | 'errors' | 'data' | 'error'>): Promise<void> {
  if (lists.error.length > 0)
    await notify('actions.onError', lists.error, { ...event, ...failure })
}

// What each action declared before the app's defaults were laid under it, so an app registered twice in a process (a test site after another) starts from the action's own options.
const declared = new WeakMap<object, ServerAction<TSchema, unknown>['protection']>()

// Lays the app's `actions` defaults under an action's own options, key by key: a check the action names replaces the app's, `messages` merge one level, and `protect: false` keeps the defaults out.
export function withActionDefaults(action: ServerAction<TSchema, unknown>, defaults: ActionsConfig | undefined): void {
  const own = declared.has(action) ? declared.get(action) : action.protection

  declared.set(action, own)

  if (defaults === undefined || own?.defaults === false) {
    if (own !== action.protection)
      Object.defineProperty(action, 'protection', { value: own, enumerable: true, configurable: true })

    return
  }

  const base = resolveProtection({ protect: defaults.protect, maxSize: defaults.maxSize, messages: defaults.messages })

  if (base === undefined || Object.keys(base).length === 0)
    return

  const messages = base.messages === undefined && own?.messages === undefined ? undefined : { ...base.messages, ...own?.messages }

  Object.defineProperty(action, 'protection', { value: { ...base, ...own, ...messages && { messages } }, enumerable: true, configurable: true })
}
