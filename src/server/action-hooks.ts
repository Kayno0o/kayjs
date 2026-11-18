import type { TSchema } from 'elysia'
import type { ActionsConfig } from '../config'
import type { ActionContext, ActionDone, ActionFailed, ActionHookContext, ActionHooks, ActionRun, ServerAction } from '../runtime/action'
import type { ErrorShape } from '../runtime/api-error'
import type { BeforeHook, Hook } from './hooks'
import { resolveProtection } from '../runtime/action-protection'
import { decide, dispatch, hookContext } from './hooks'

// The hooks of one action in the order they run: the app's, then the action's own.
export interface ActionHookLists {
  before: BeforeHook<ActionRun, never, ActionHookContext>[]
  success: Hook<ActionDone, ActionHookContext>[]
  error: Hook<ActionFailed, ActionHookContext>[]
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

// The `context` of an action's hooks: the action's own, read through it as it is lazy, with who asks.
async function contextOf(ctx: ActionContext): Promise<ActionHookContext> {
  const { ip, userAgent, userId } = await hookContext()

  return Object.create(ctx, { ip: { value: ip, enumerable: true }, userAgent: { value: userAgent, enumerable: true }, userId: { value: userId, enumerable: true } }) as ActionHookContext
}

// The `beforeRun` hooks of a run: the refusal when one stops it.
export async function refusedBeforeRun(lists: ActionHookLists, event: ActionRun, ctx: ActionContext): Promise<(ErrorShape & { retryAfter?: number | undefined }) | undefined> {
  if (lists.before.length === 0)
    return undefined

  const answer = await decide('actions.beforeRun', lists.before, event, await contextOf(ctx))

  return 'refused' in answer ? answer.refused : undefined
}

export async function tellSuccess(lists: ActionHookLists, event: ActionRun, ctx: ActionContext, result: unknown): Promise<void> {
  if (lists.success.length > 0)
    await dispatch('actions.onSuccess', lists.success, { ...event, result }, { context: await contextOf(ctx) })
}

export async function tellError(lists: ActionHookLists, event: ActionRun, ctx: ActionContext, failure: Pick<ActionFailed, 'status' | 'message' | 'errors' | 'data' | 'error'>): Promise<void> {
  if (lists.error.length > 0)
    await dispatch('actions.onError', lists.error, { ...event, ...failure }, { context: await contextOf(ctx) })
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
