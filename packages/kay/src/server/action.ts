// Unified server actions: works as both progressive <form action={fn} method="post"> and typed island RPC.

import type { Cookies } from './cookies'
import type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1 } from './standard-schema'
import { isTrustedOrigin, verifyOrigin } from './security'
import { validateSchema } from './standard-schema'

export const ACTION_ERROR_COOKIE = '__kay_action_err'

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
): ServerAction<InferInput<S>, Exclude<Output, Response>>
export function action<Output>(
  handler: (ctx: ActionContext) => Output | Response | Promise<Output | Response>,
): ServerAction<void, Exclude<Output, Response>>
export function action(
  schemaOrHandler: StandardSchemaV1 | ((ctx: ActionContext) => unknown),
  maybeHandler?: (input: never, ctx: ActionContext) => unknown,
): ServerAction<unknown, unknown> {
  const hasSchema = typeof schemaOrHandler !== 'function'
  const schema = hasSchema ? schemaOrHandler : undefined
  const handler = hasSchema
    ? maybeHandler!
    : ((_input: never, ctx: ActionContext) => (schemaOrHandler as (c: ActionContext) => unknown)(ctx))

  const fn = (async () => {
    throw new Error('kay: server action cannot be called directly without a request context; invoke it from an island or via HTTP POST')
  }) as unknown as ServerAction<unknown, unknown> & { url: string }

  Object.defineProperties(fn, {
    __kayAction: { value: true, enumerable: false },
    schema: { value: schema, enumerable: false },
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

async function parseActionBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json'))
    return request.json()

  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    const fd = await request.formData()
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

export async function executeAction(
  act: ServerAction<unknown, unknown>,
  request: Request,
  ctx: ActionContext,
  trustedOrigins?: ReadonlySet<string>,
): Promise<Response> {
  const originCheck = verifyOrigin(request, trustedOrigins)
  if (!originCheck.ok) {
    return Response.json(
      { ok: false, status: 403, error: originCheck.reason },
      { status: 403 },
    )
  }

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
      // Zero-JS progressive HTML <form> submit: flash fieldErrors + submitted string values and redirect 303 back to trusted Referer
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
          if (refUrl !== undefined && isTrustedOrigin(refUrl.origin, request, trustedOrigins)) {
            const values: Record<string, string> = {}
            if (rawBody !== null && typeof rawBody === 'object') {
              for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
                if (typeof v === 'string' && !/password|secret|token/i.test(k) && v.length <= 512)
                  values[k] = v
              }
            }
            const flash: ActionErrorFlash = {
              action: act.url,
              error: 'Validation failed',
              fieldErrors: checked.fieldErrors,
              ...(Object.keys(values).length > 0 ? { values } : {}),
            }
            ctx.cookies.set(ACTION_ERROR_COOKIE, JSON.stringify(flash), {
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
      if (refUrl !== undefined && isTrustedOrigin(refUrl.origin, request, trustedOrigins))
        return Response.redirect(refUrl.href, 303)
    }
  }

  return Response.json({ ok: true, data: result }, { status: 200 })
}
