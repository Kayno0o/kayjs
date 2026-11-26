// Unified server actions: works as both progressive <form action={fn} method="post"> and typed island RPC.

import type { Cookies } from './cookies'
import type { KayLocals } from './index'
import type { TrustProxy } from './security'
import type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1, ValidationFailure, ValidationResult } from './standard-schema'
import { wantsJson } from './http'
import { currentRequest } from './request-scope'
import { isTrustedOrigin } from './security'
import { validateSchema } from './standard-schema'

declare module './index' {
  interface KayLocals {
    actionError?: ActionErrorFlash | undefined
  }
}

export const ACTION_ERROR_COOKIE = '__kay_action_err'

const MAX_FLASH_COOKIE_BYTES = 3500
const MAX_FLASH_FIELD_CHARS = 512
// Substrings that are unambiguously sensitive even inside compound identifiers.
const SENSITIVE_SUBSTRING_RE = /password|passwd|passphrase|passcode|motdepasse|secret|token|jeton|credit|debit|card|carte|iban|routing|account|compte|bank|banque|bancaire|securite|vitale|passeport|passport|fiscal|impot|crypto|sante|medical|health|biometr|credential|private|session|bearer|csrf|xsrf|naissance/i
// Short acronyms/words matched only on token boundaries (after camelCase/punctuation/accent normalization) to avoid false positives like `subscribe`, `article`, `souvenir`, or `description`.
const SENSITIVE_TOKEN_RE = /\b(?:mot de passe|mdp|pwd|pin|cvv|cvc|csc|ccv|rib|bic|sepa|cb|nir|secu|insee|cni|siret|siren|permis|ssn|sin|nin|tin|pan|otp|totp|mfa|2fa|auth|key|cle|code|tax|jwt)\b/i

function isSensitiveField(name: string): boolean {
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
  return SENSITIVE_SUBSTRING_RE.test(normalized) || SENSITIVE_TOKEN_RE.test(normalized)
}

/** Hydrates `ctx.locals.actionError` from `__kay_action_err` without clearing the cookie yet; returns true when the cookie was present. */
export function hydrateActionErrorFlash(ctx: Pick<ActionContext, 'cookies' | 'locals'>): boolean {
  const rawFlash = ctx.cookies.get(ACTION_ERROR_COOKIE)
  if (rawFlash === undefined)
    return false
  try {
    const parsed: unknown = JSON.parse(rawFlash)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ctx.locals.actionError = parsed as unknown as ActionErrorFlash
  }
  catch {}
  return true
}

/** Converts 3xx action/middleware redirects into a 204 + `x-kay-redirect` header for `actionStub` (`x-kay-action: 1`), preventing double-fetch and cross-origin CORS failures in browsers. */
export function finishActionRedirect(res: Response, request: Request): Response {
  if (request.headers.get('x-kay-action') !== '1' || res.status < 300 || res.status >= 400)
    return res
  const location = res.headers.get('location')
  if (location === null)
    return res
  const headers = new Headers()
  for (const cookie of res.headers.getSetCookie())
    headers.append('set-cookie', cookie)
  headers.set('x-kay-redirect', location)
  return new Response(null, { status: 204, headers })
}

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

export function getActionError(locals?: KayLocals): ActionErrorFlash | undefined {
  return locals?.actionError
}

export interface ActionContext {
  request: Request
  url: URL
  cookies: Cookies
  locals: KayLocals
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

  const fn = (async (input: unknown) => {
    const scope = currentRequest()
    if (scope === undefined)
      throw new Error(`kay: ${fn.name || 'a server action'} was called outside a request; call it from a route, load(), middleware or another action, or with app.submit in a test.`)
    return scope.actions.invoke(fn, input, scope.ctx)
  }) as unknown as ServerAction<unknown, unknown> & { url: string }

  Object.defineProperties(fn, {
    // The registry names it after its export.
    name: { value: '', configurable: true },
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
    // A Map then fromEntries makes every name an own property, `constructor` and `__proto__` included.
    const fields = new Map<string, FormDataEntryValue | FormDataEntryValue[]>()
    for (const [key, val] of (await boundedReq.formData()).entries()) {
      const prev = fields.get(key)
      if (prev === undefined) {
        fields.set(key, val)
      }
      else if (Array.isArray(prev)) {
        prev.push(val)
      }
      else {
        fields.set(key, [prev, val])
      }
    }
    return Object.fromEntries(fields)
  }

  return undefined
}

function isJsonBody(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').includes('application/json')
}

// The page a form came from, when its origin is one this server trusts: where a no-JS submit goes back to.
function trustedReferer(request: Request, trustedOrigins: ReadonlySet<string> | undefined, trustProxy: TrustProxy, requestUrl?: URL): URL | undefined {
  const referer = request.headers.get('referer')
  if (!referer)
    return undefined
  let refUrl: URL
  try {
    refUrl = new URL(referer)
  }
  catch {
    return undefined
  }
  return isTrustedOrigin(refUrl.origin, request, trustedOrigins, trustProxy, requestUrl) ? refUrl : undefined
}

function topLevelKey(issue: StandardSchemaIssue): string | undefined {
  const seg = issue.path?.length === 1 ? issue.path[0] : undefined
  const key = typeof seg === 'object' && seg !== null ? seg.key : seg
  return typeof key === 'string' ? key : undefined
}

function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

const ARRAY_WORD_RE = /\barray\b/i
const MISSING_WORD_RE = /\b(?:required|missing|undefined)\b/i
const NON_ARRAY_TYPE_RE = /\b(?:string|number|boolean|object|file|date|bigint|symbol)\b/i

function looksLikeFormArrayMismatch(issue: StandardSchemaIssue, body: Record<string, unknown>, key: string): boolean {
  const meta = issue as { code?: unknown, expected?: unknown, type?: unknown }
  if (typeof meta.expected === 'string')
    return ARRAY_WORD_RE.test(meta.expected)
  if (typeof meta.type === 'string') {
    if (meta.type.toLowerCase() === 'array')
      return true
    if (NON_ARRAY_TYPE_RE.test(meta.type))
      return false
  }
  if (typeof meta.code === 'string' && meta.code !== 'invalid_type')
    return false
  if (ARRAY_WORD_RE.test(issue.message))
    return true
  // An unchecked checkbox group is omitted from FormData; generic "Required"/"missing" messages without a non-array type may be expecting [].
  return !Object.hasOwn(body, key) && MISSING_WORD_RE.test(issue.message) && !NON_ARRAY_TYPE_RE.test(issue.message)
}

// A form sends one checked box as a single value and none as nothing, so a field the schema wants as an array fails. Each failing top-level field whose issue looks like a missing/non-array type mismatch is retried as an array, and the array is kept only where it clears that field's issue.
async function retryWithFormArrays(schema: StandardSchemaV1, body: Record<string, unknown>, failed: ValidationFailure): Promise<ValidationResult<unknown>> {
  const retried = { ...body }
  const wrapped: string[] = []
  for (const issue of failed.issues) {
    const key = topLevelKey(issue)
    if (key === undefined || Array.isArray(retried[key]) || wrapped.includes(key))
      continue
    if (!looksLikeFormArrayMismatch(issue, body, key))
      continue
    setField(retried, key, Object.hasOwn(body, key) ? [body[key]] : [])
    wrapped.push(key)
  }
  if (wrapped.length === 0)
    return failed
  const second = await validateSchema(schema, retried)
  if (second.ok)
    return second
  const stillFailing = new Set(second.issues.map(topLevelKey))
  const kept = wrapped.filter(key => !stillFailing.has(key))
  if (kept.length === 0)
    return failed
  for (const key of wrapped) {
    if (kept.includes(key))
      continue
    if (Object.hasOwn(body, key))
      setField(retried, key, body[key])
    else
      delete retried[key]
  }
  return kept.length === wrapped.length ? second : validateSchema(schema, retried)
}

function encodedFlashSize(flash: ActionErrorFlash): number {
  return Buffer.byteLength(encodeURIComponent(JSON.stringify(flash)), 'utf8')
}

function buildActionErrorFlash(
  actionUrl: string,
  error: string,
  fieldErrors: Record<string, string> | undefined,
  rawBody: unknown,
  flashFields?: readonly string[],
): string {
  const trimmedError = error.length > 256 ? error.slice(0, 256) : error
  const base: ActionErrorFlash = {
    action: actionUrl,
    error: trimmedError,
  }
  if (fieldErrors !== undefined) {
    const safeErrors: Record<string, string> = {}
    base.fieldErrors = safeErrors
    for (const [k, msg] of Object.entries(fieldErrors)) {
      const trimmed = msg.length > 256 ? msg.slice(0, 256) : msg
      safeErrors[k] = trimmed
      if (encodedFlashSize(base) > MAX_FLASH_COOKIE_BYTES) {
        delete safeErrors[k]
        break
      }
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
      else if (isSensitiveField(k)) {
        continue
      }
      values[k] = v
      const candidate: ActionErrorFlash = { ...base, values }
      if (encodedFlashSize(candidate) > MAX_FLASH_COOKIE_BYTES) {
        delete values[k]
        break
      }
    }
  }

  const finalFlash: ActionErrorFlash = {
    ...base,
    ...(Object.keys(values).length > 0 ? { values } : {}),
  }
  return JSON.stringify(finalFlash)
}

/** Programmatic action invocation with Standard Schema validation (used by `ServerPluginAPI.invokeAction` inside middleware chains). */
export async function invokeActionCore<I, O>(
  act: ServerAction<I, O>,
  input: I,
  ctx: ActionContext,
): Promise<ActionResult<O>> {
  let validated: unknown = input
  if (act.schema !== undefined) {
    const checked = await validateSchema(act.schema, input)
    if (!checked.ok) {
      return {
        ok: false,
        status: 400,
        error: 'Validation failed',
        fieldErrors: checked.fieldErrors,
        issues: checked.issues,
      }
    }
    validated = checked.value
  }

  const result = await act.handler(validated as never, ctx)
  if (result instanceof Response) {
    if (result.status >= 300 && result.status < 400)
      return { ok: true, data: result as unknown as O }
    const ok = result.status >= 200 && result.status < 300
    const ct = result.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        const body = await result.clone().json() as Record<string, unknown>
        if (typeof body === 'object' && body !== null && 'ok' in body)
          return body as unknown as ActionResult<O>
        return ok
          ? { ok: true, data: body as O }
          : {
              ok: false,
              status: result.status,
              error: typeof body.error === 'string' ? body.error : result.statusText,
              ...(body.fieldErrors !== undefined ? { fieldErrors: body.fieldErrors as Record<string, string> } : {}),
            }
      }
      catch {}
    }
    return ok
      ? { ok: true, data: undefined as O }
      : { ok: false, status: result.status, error: (await result.clone().text().catch(() => '')) || result.statusText }
  }
  return { ok: true, data: result as O }
}

export async function executeAction(
  act: ServerAction<unknown, unknown>,
  request: Request,
  ctx: ActionContext,
  trustedOrigins?: ReadonlySet<string>,
  trustProxy: TrustProxy = false,
): Promise<Response> {
  const json = wantsJson(request)
  const flashAndRedirect = (error: string, fieldErrors: Record<string, string> | undefined, rawBody: unknown): Response | undefined => {
    const back = json ? undefined : trustedReferer(request, trustedOrigins, trustProxy, ctx.url)
    if (back === undefined)
      return undefined
    ctx.cookies.set(ACTION_ERROR_COOKIE, buildActionErrorFlash(act.url, error, fieldErrors, rawBody, act.flashFields), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60,
    })
    return new Response(null, { status: 303, headers: { location: back.href } })
  }

  let rawBody: unknown
  let input: unknown
  if (act.schema !== undefined) {
    try {
      rawBody = await parseActionBody(request)
    }
    catch {
      return Response.json({ ok: false, status: 400, error: 'Invalid request body' }, { status: 400 })
    }

    let checked = await validateSchema(act.schema, rawBody)
    if (!checked.ok && !isJsonBody(request) && rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody))
      checked = await retryWithFormArrays(act.schema, rawBody as Record<string, unknown>, checked)
    if (!checked.ok) {
      // Zero-JS progressive HTML <form> submit: flash fieldErrors + safe submitted values (<4KB) and redirect 303 back to trusted Referer
      const redirected = flashAndRedirect('Validation failed', checked.fieldErrors, rawBody)
      if (redirected !== undefined)
        return redirected
      return Response.json(
        { ok: false, status: 400, error: 'Validation failed', fieldErrors: checked.fieldErrors, issues: checked.issues },
        { status: 400 },
      )
    }
    input = checked.value
  }

  // Track exact Response instances produced by `ctx.deny()` so zero-JS form submits flash & 303-redirect while custom Responses (redirects, downloads, custom JSON) pass through untouched.
  let deniedResponses: Map<Response, { message: string, fieldErrors?: Record<string, string> | undefined }> | undefined
  const actionCtx: ActionContext = Object.create(ctx, {
    deny: {
      value: (status: number, message: string, fieldErrors?: Record<string, string>) => {
        const res = ctx.deny(status, message, fieldErrors)
        ;(deniedResponses ??= new Map()).set(res, { message, fieldErrors })
        return res
      },
      enumerable: true,
    },
  })

  const result = await act.handler(input as never, actionCtx)
  if (result instanceof Response) {
    const denied = deniedResponses?.get(result)
    if (denied !== undefined) {
      const redirected = flashAndRedirect(denied.message, denied.fieldErrors, rawBody)
      if (redirected !== undefined)
        return redirected
    }
    return result
  }

  const back = json ? undefined : trustedReferer(request, trustedOrigins, trustProxy, ctx.url)
  if (back !== undefined)
    return new Response(null, { status: 303, headers: { location: back.href } })

  return Response.json({ ok: true, data: result }, { status: 200 })
}
