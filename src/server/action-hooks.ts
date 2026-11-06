import type { TSchema } from 'elysia'
import type { ActionsConfig } from '../config'
import type { ActionDone, ActionFailed, ActionHooks, ActionRun, ServerAction } from '../runtime/action'
import type { ErrorShape } from '../runtime/api-error'
import type { BeforeHook, Hook } from './hooks'
import { resolveProtection } from '../runtime/action-protection'
import { decide, dispatch } from './hooks'

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
    await dispatch('actions.onSuccess', lists.success, { ...event, result })
}

export async function tellError(lists: ActionHookLists, event: ActionRun, failure: Pick<ActionFailed, 'status' | 'message' | 'errors' | 'data' | 'error'>): Promise<void> {
  if (lists.error.length > 0)
    await dispatch('actions.onError', lists.error, { ...event, ...failure })
}

// The action as one app serves it, with the app's `actions` defaults laid under its own options key by key: a check the action names replaces the app's, `messages` merge one level, and `protect: false` keeps the app's checks out (its `maxSize` and `messages` still apply). The action itself is left as declared, so two apps in one process (a test site after another) each read their own defaults.
export function withActionDefaults(action: ServerAction<TSchema, unknown>, defaults: ActionsConfig | undefined): ServerAction<TSchema, unknown> {
  const own = action.protection

  if (defaults === undefined)
    return action

  const base = resolveProtection({ protect: own?.defaults === false ? false : defaults.protect, maxSize: defaults.maxSize, messages: defaults.messages })

  if (base === undefined || Object.keys(base).length === 0)
    return action

  const rest = { ...base, defaults: undefined }
  const messages = rest.messages === undefined && own?.messages === undefined ? undefined : { ...rest.messages, ...own?.messages }

  return Object.create(action, { protection: { value: { ...rest, ...own, ...messages && { messages } }, enumerable: true } }) as ServerAction<TSchema, unknown>
}
