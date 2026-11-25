// Unified server actions: works as both progressive <form action={fn} method="post"> and typed island RPC.

import type { Cookies } from './cookies'
import type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1 } from './standard-schema'
import { isTrustedOrigin } from './security'
import { validateSchema } from './standard-schema'

export const ACTION_ERROR_COOKIE = '__kay_action_err'

const MAX_FLASH_COOKIE_BYTES = 3500
const MAX_FLASH_FIELD_CHARS = 512
const SENSITIVE_FIELD_RE = /password|passwd|pwd|secret|token|pin|cvv|cvc|iban|ssn|card|credit|auth|key|otp|code|routing|account|bank|tax/i

export interface ActionOptions {
  /** Explicit allowlist of form field names permitted in the progressive-form validation error flash cookie. */
  flashFields?: readonly string[] | undefined
}

export interface ActionErrorFlash {
  action: string
  error: string
  fieldErrors?: Record<string, string> | undefined
  values?: Record<string, string> | undefined
}

export function getActionError(locals?: Record<string, unknown>): ActionErrorFlash | undefined {
  return locals?.actionError as ActionErrorFlash | undefined
}

export interface ActionContext {
  request: Request
  url: URL
  params: Record<string, string>
  cookies: Cookies
  locals: Record<string, unknown>
  ip?: string | undefined
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => Response
  deny: (status: number, message: string, fieldErrors?: Record<string, string>) => Response
}

export type ActionResult<Output> =
  | { ok: true, data: Output }
  | { ok: false, status: number, error: string, fieldErrors?: Record<string, string>, issues?: ReadonlyArray<StandardSchemaIssue> }

export interface ServerAction<Input, Output> {
  (input: Input): Promise<ActionResult<Output>>
  readonly __kayAction: true
  readonly url: string
  readonly schema: StandardSchemaV1 | undefined
  readonly flashFields: readonly string[] | undefined
  readonly handler: (input: never, ctx: ActionContext) => Output | Response | Promise<Output | Response>
  toString(): string
}

export function actionHash(relFile: string, exportName: string): string {
  const h = Bun.hash.wyhash(`${relFile}#${exportName}`).toString(36)
  return `${exportName.toLowerCase()}-${h.slice(0, 8)}`
}

export function action<S extends StandardSchemaV1, Output>(
  schema: S,
  handler: (input: InferOutput<S>, ctx: ActionContext) => Output | Response | Promise<Output | Response>,
  options?: ActionOptions,
): ServerAction<InferInput<S>, Exclude<Output, Response>>
export function action<Output>(
  handler: (ctx: ActionContext) => Output | Response | Promise<Output | Response>,
  options?: ActionOptions,
): ServerAction<void, Exclude<Output, Response>>
export function action(
  schemaOrHandler: StandardSchemaV1 | ((ctx: ActionContext) => unknown),
  maybeHandlerOrOpts?: ((input: never, ctx: ActionContext) => unknown) | ActionOptions,
  maybeOpts?: ActionOptions,
): ServerAction<unknown, unknown> {
  const hasSchema = typeof schemaOrHandler !== 'function'
  const schema = hasSchema ? schemaOrHandler : undefined
  const handler = hasSchema
    ? (maybeHandlerOrOpts as (input: never, ctx: ActionContext) => unknown)
    : ((_input: never, ctx: ActionContext) => (schemaOrHandler as (c: ActionContext) => unknown)(ctx))
  const options = hasSchema ? maybeOpts : (maybeHandlerOrOpts as ActionOptions | undefined)

  const fn = (async () => {
    throw new Error('kay: server action cannot be called directly without a request context; invoke it from an island or via HTTP POST')
  }) as unknown as ServerAction<unknown, unknown> & { url: string }

  Object.defineProperties(fn, {
    __kayAction: { value: true, enumerable: false },
    schema: { value: schema, enumerable: false },
    flashFields: { value: options?.flashFields, enumerable: false },
    handler: { value: handler, enumerable: false },
    url: { value: '', writable: true, enumerable: true },
    toString: {
      value() {
        return fn.url
      },
      enumerable: false,
    },
  })

  return fn
}

export function isServerAction(value: unknown): value is ServerAction<unknown, unknown> {
  return typeof value === 'function' && (value as { __kayAction?: boolean }).__kayAction === true
}

async function parseActionBody(boundedReq: Request): Promise<unknown> {
  const contentType = boundedReq.headers.get('content-type') ?? ''
  if (contentType.includes('application/json'))
    return boundedReq.json()

  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    const fd = await boundedReq.formData()
    const out: Record<string, unknown> = {}
    for (const [key, val] of fd.entries()) {
      if (key in out) {
        const prev = out[key]
        out[key] = Array.isArray(prev) ? [...prev, val] : [prev, val]
      }
      else {
        out[key] = val
      }
    }
    return out
  }

  return undefined
}

function encodedFlashSize(flash: ActionErrorFlash): number {
  return Buffer.byteLength(encodeURIComponent(JSON.stringify(flash)), 'utf8')
}

function buildActionErrorFlash(
  actionUrl: string,
  fieldErrors: Record<string, string>,
  rawBody: unknown,
  flashFields?: readonly string[],
): string {
  const safeErrors: Record<string, string> = {}
  const base: ActionErrorFlash = {
    action: actionUrl,
    error: 'Validation failed',
    fieldErrors: safeErrors,
  }
  for (const [k, msg] of Object.entries(fieldErrors)) {
    const trimmed = msg.length > 256 ? msg.slice(0, 256) : msg
    safeErrors[k] = trimmed
    if (encodedFlashSize(base) > MAX_FLASH_COOKIE_BYTES) {
      delete safeErrors[k]
      break
    }
  }

  const allowSet = flashFields !== undefined ? new Set(flashFields) : undefined
  const values: Record<string, string> = {}
  if (rawBody !== null && typeof rawBody === 'object') {
    for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length > MAX_FLASH_FIELD_CHARS)
        continue
      if (allowSet !== undefined) {
        if (!allowSet.has(k))
          continue
      }
      else if (SENSITIVE_FIELD_RE.test(k)) {
        continue
      }
      values[k] = v
      const candidate: ActionErrorFlash = { ...base, values }
      if (encodedFlashSize(candidate) > MAX_FLASH_COOKIE_BYTES)
        delete values[k]
    }
  }

  const finalFlash: ActionErrorFlash = {
    ...base,
    ...(Object.keys(values).length > 0 ? { values } : {}),
  }
  return JSON.stringify(finalFlash)
}

export async function executeAction(
  act: ServerAction<unknown, unknown>,
  request: Request,
  ctx: ActionContext,
  trustedOrigins?: ReadonlySet<string>,
  trustProxy = false,
): Promise<Response> {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json')
    || (request.headers.get('content-type') ?? '').includes('application/json')

  let input: unknown
  if (act.schema !== undefined) {
    let rawBody: unknown
    try {
      rawBody = await parseActionBody(request)
    }
    catch {
      return Response.json({ ok: false, status: 400, error: 'Invalid request body' }, { status: 400 })
    }

    const checked = await validateSchema(act.schema, rawBody)
    if (!checked.ok) {
      // Zero-JS progressive HTML <form> submit: flash fieldErrors + safe submitted values (<4KB) and redirect 303 back to trusted Referer
      if (!wantsJson) {
        const referer = request.headers.get('referer')
        if (referer) {
          let refUrl: URL | undefined
          try {
            refUrl = new URL(referer)
          }
          catch {
            refUrl = undefined
          }
          if (refUrl !== undefined && isTrustedOrigin(refUrl.origin, request, trustedOrigins, trustProxy)) {
            const serializedFlash = buildActionErrorFlash(act.url, checked.fieldErrors, rawBody, act.flashFields)
            ctx.cookies.set(ACTION_ERROR_COOKIE, serializedFlash, {
              httpOnly: true,
              sameSite: 'lax',
              maxAge: 60,
            })
            return Response.redirect(refUrl.href, 303)
          }
        }
      }
      return Response.json(
        { ok: false, status: 400, error: 'Validation failed', fieldErrors: checked.fieldErrors, issues: checked.issues },
        { status: 400 },
      )
    }
    input = checked.value
  }

  const result = await act.handler(input as never, ctx)
  if (result instanceof Response)
    return result

  if (!wantsJson) {
    const referer = request.headers.get('referer')
    if (referer) {
      let refUrl: URL | undefined
      try {
        refUrl = new URL(referer)
      }
      catch {
        refUrl = undefined
      }
      if (refUrl !== undefined && isTrustedOrigin(refUrl.origin, request, trustedOrigins, trustProxy))
        return Response.redirect(refUrl.href, 303)
    }
  }

  return Response.json({ ok: true, data: result }, { status: 200 })
}
