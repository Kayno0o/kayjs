import type { Issue, Source } from './validate'
import { isStandardSchema } from '../runtime/standard-schema'
import { isRefusal, validate } from './validate'

// What a route's `body`, `query`, `params`, `headers` and `cookie` schemas were declared as, kept where OpenAPI reads them since Elysia is left none to validate with.
const DECLARED = Symbol.for('kay.apiInputs')

const INPUTS = ['body', 'query', 'params', 'headers', 'cookie'] as const

type Input = typeof INPUTS[number]

type Hooks = Partial<Record<Input, unknown>> & { transform?: unknown, [DECLARED]?: Partial<Record<Input, object>> }

// Input a route's schema refused. It carries Elysia's `VALIDATION` code and the shape of its error, so an `onError` hook that answers refused input still reads it as it did.
export class InputRefused extends Error {
  readonly code = 'VALIDATION'
  readonly status = 422

  constructor(readonly type: Input, readonly errors: Issue[]) {
    super(`Invalid ${type}: ${errors.map(issue => issue.message).join('; ')}`)
    this.name = 'InputRefused'
  }

  get all(): { path: string, message: string, summary: string }[] {
    return this.errors.map(issue => ({ path: `/${issue.path.replaceAll('.', '/')}`, message: issue.message, summary: issue.message }))
  }
}

// The input schemas of a route as it was declared.
export function declaredInputs(hooks: unknown): Partial<Record<Input, object>> {
  return (hooks as Hooks | undefined)?.[DECLARED] ?? {}
}

// A query, the headers and the cookies of a request carry what the schema does not name, which is dropped, not refused.
function lenient(schema: object): object {
  if (isStandardSchema(schema))
    return schema

  const copy: Record<PropertyKey, unknown> = { ...schema, 'x-kay-extra': 'strip' }

  delete copy.additionalProperties

  return copy
}

const FORM_BODY = /^(?:multipart\/form-data|application\/x-www-form-urlencoded)\b/i

function sourceOf(input: Input, request: Request): Source {
  if (input === 'body')
    return FORM_BODY.test(request.headers.get('content-type') ?? '') ? 'form' : 'json'

  return input === 'query' ? 'query' : 'params'
}

interface InputContext {
  request: Request
  body?: unknown
  query?: unknown
  params?: unknown
  headers?: unknown
  cookie?: unknown
}

// The value of each cookie, as Elysia hands the jar over as objects holding it.
function cookieValues(jar: unknown): unknown {
  if (typeof jar !== 'object' || jar === null)
    return jar

  return Object.fromEntries(Object.entries(jar).map(([name, cookie]) => [name, (cookie as { value?: unknown } | undefined)?.value]))
}

// Takes the route's input schemas out of Elysia's validation, which would call their `error` functions outside the request's locale, and checks them in a hook of its own, the value read being the one the handler gets. Reading each by its property tells Elysia the route needs it parsed.
export function validatingInputs(hooks: unknown, inLocale: <T>(request: Request, run: () => T) => T): void {
  const route = hooks as Hooks | undefined
  const declared: Partial<Record<Input, object>> = {}

  if (route === undefined)
    return

  for (const input of INPUTS) {
    const schema = route[input]

    if (typeof schema === 'object' && schema !== null) {
      declared[input] = schema
      route[input] = undefined
    }
  }

  if (Object.keys(declared).length === 0)
    return

  const checked: Partial<Record<Input, object>> = Object.fromEntries(Object.entries(declared).map(([input, schema]) => [input, input === 'body' || input === 'params' ? schema : lenient(schema)]))

  route[DECLARED] = declared
  route.transform = [...[route.transform ?? []].flat() as unknown[], async (context: InputContext) => {
    const given = { body: context.body, query: context.query, params: context.params, headers: context.headers, cookie: cookieValues(context.cookie) }

    for (const input of INPUTS) {
      const schema = checked[input]

      if (schema === undefined)
        continue

      const result = await inLocale(context.request, async () => validate(schema, given[input], { source: sourceOf(input, context.request) }))

      if (isRefusal(result))
        throw new InputRefused(input, result.errors)

      if (input !== 'cookie')
        (context as unknown as Record<string, unknown>)[input] = result.value
    }
  }]
}
