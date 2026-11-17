import type { Issue, Source } from './validate'
import { isStandardSchema } from '../runtime/standard-schema'
import { isRefusal, validate } from './validate'

// What a route's `body`, `query`, `params`, `headers` and `cookie` schemas were declared as, kept where OpenAPI reads them since Elysia is left none to validate with.
const DECLARED = Symbol.for('kay.apiInputs')

const INPUTS = ['body', 'query', 'params', 'headers', 'cookie'] as const

type Input = typeof INPUTS[number]

type Hooks = Partial<Record<Input, unknown>> & { transform?: unknown, standaloneValidator?: Partial<Record<Input, unknown>>[], [DECLARED]?: Partial<Record<Input, object>> }

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

// A query, the headers and the cookies of a request carry what the schema does not name, which is dropped, not refused; so does a body or params with several schemas, a guard's beside the route's, each naming fields the others lack.
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
// A key the query repeats is a list of its values: Elysia reads it so only for a schema it holds itself, which it is left none of.
function withRepeats(request: Request, parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null)
    return parsed

  const { searchParams } = new URL(request.url)
  const repeated = Object.fromEntries([...new Set(searchParams.keys())].map(key => [key, searchParams.getAll(key)] as const).filter(([, values]) => values.length > 1))

  return Object.keys(repeated).length === 0 ? parsed : { ...parsed, ...repeated }
}

export function validatingInputs(hooks: unknown, inLocale: <T>(request: Request, run: () => T) => T): void {
  const route = hooks as Hooks | undefined
  const declared: Partial<Record<Input, object>> = {}
  // Every schema an input has: the route's own, and one for each guard around it, which Elysia keeps apart and checks one by one.
  const all: Partial<Record<Input, object[]>> = {}

  if (route === undefined)
    return

  for (const input of INPUTS) {
    for (const holder of [route, ...route.standaloneValidator ?? []]) {
      const schema = holder[input]

      if (typeof schema === 'object' && schema !== null) {
        (all[input] ??= []).push(schema)
        declared[input] ??= schema
        holder[input] = undefined
      }
    }
  }

  if (Object.keys(declared).length === 0)
    return

  const checked: Partial<Record<Input, object[]>> = Object.fromEntries(Object.entries(all).map(([input, schemas]) => [input, (input === 'body' || input === 'params') && schemas.length === 1 ? schemas : schemas.map(lenient)]))

  route[DECLARED] = declared

  // What an input reads as, or the refusal thrown: the schemas it has, the route's own and its guards', checked one after the other.
  const settle = async (input: Input, request: Request, given: unknown): Promise<unknown> => {
    const schemas = checked[input]

    if (schemas === undefined)
      return given

    // Each schema reads what was sent, not what another dropped from it: a form post loses the fields a schema does not name, and a guard's schema names others than the route's.
    const outputs: unknown[] = []
    const refused = new Map<string, Issue>()

    for (const schema of schemas) {
      const result = await inLocale(request, async () => validate(schema, given, { source: sourceOf(input, request) }))

      if (!isRefusal(result)) {
        outputs.push(result.value)

        continue
      }

      for (const issue of result.errors) {
        if (!refused.has(issue.path))
          refused.set(issue.path, issue)
      }
    }

    if (refused.size > 0)
      throw new InputRefused(input, [...refused.values()])

    const plain = outputs.every(output => typeof output === 'object' && output !== null && !Array.isArray(output))

    return plain ? Object.assign({}, ...outputs) as unknown : outputs.at(-1)
  }

  // One hook per input, each naming its own property and never passing the context on: Elysia reads a hook's source to know what to parse, so a route declaring only a `query` leaves its body to the handler.
  const readers: Record<Input, (context: InputContext) => Promise<void>> = {
    body: async (context) => {
      context.body = await settle('body', context.request, context.body)
    },
    query: async (context) => {
      context.query = await settle('query', context.request, withRepeats(context.request, context.query))
    },
    params: async (context) => {
      context.params = await settle('params', context.request, context.params)
    },
    headers: async (context) => {
      context.headers = await settle('headers', context.request, context.headers)
    },
    cookie: async (context) => {
      await settle('cookie', context.request, cookieValues(context.cookie))
    },
  }

  route.transform = [...[route.transform ?? []].flat() as unknown[], ...INPUTS.filter(input => declared[input] !== undefined).map(input => readers[input])]
}
