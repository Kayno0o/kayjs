import type { Elysia } from 'elysia'
import { getSchemaValidator, ValidationError } from 'elysia'
import { ElysiaWS } from 'elysia/ws'
import { underKayDev } from '../build/assets'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { refusedFields } from './field-errors'
import { bindReply } from './rooms'
import { kayWord } from './words'
import { admissionOf, frameGuard } from './ws-limits'

// The protocol of a websocket route: every frame is JSON, in both directions, so a string, a number, a boolean or `null` reads back as what it was.
// A message the route refuses is answered `{ error: { key, fields } }`, `key` naming what was wrong and `fields` the words for each field, never the schema.
export interface SocketRefusalFrame {
  error: { key: 'kay.socket.notJson' | 'kay.socket.invalid', fields: Record<string, string> }
}

// What a route hands the protocol: the handlers of its options, and what the route knows of itself.
export interface SocketRoute {
  open?: ((ws: Peer) => unknown) | undefined
  message?: ((ws: Peer, message: never) => unknown) | undefined
  close?: ((ws: Peer, code: number, reason: string) => unknown) | undefined
  // Checks a decoded message against the route's `body`, answering what the handler gets or why it is refused.
  check?: ((message: unknown) => Checked) | undefined
  // Hands a failure to the route's `error` hooks and the app's `onError`, answering whether one took it.
  fail?: ((error: unknown, data: object, ws: Peer) => Promise<boolean>) | undefined
}

type Peer = ElysiaWS
type Checked = { value: unknown } | { refused: ValidationError, schema: unknown } | Promise<{ value: unknown } | { refused: ValidationError, schema: unknown }>

interface Replying {
  validator?: { provider?: string, Check?: (value: unknown) => boolean, schema?: { '~standard': { validate: (value: unknown) => unknown } } }
}

const isBinary = (data: unknown): data is Uint8Array | ArrayBuffer => data instanceof ArrayBuffer || ArrayBuffer.isView(data)

// The frame a value is sent as: its JSON, checked first against the route's `response` when it has one. A buffer is sent as the binary frame it is.
// Elysia would send a string as it is, which a client could not tell from a number's text, and the schema's own words when the value fails it.
function frameOf(value: unknown, validator: Replying['validator']): string | Uint8Array | ArrayBuffer | undefined {
  if (isBinary(value))
    return value

  if (validator?.provider === 'standard') {
    const result = validator.schema?.['~standard'].validate(value) as { issues?: unknown } | Promise<unknown> | undefined

    if (result !== undefined && !(result instanceof Promise) && result.issues !== undefined)
      throw new KayError('socket-reply-invalid', 'kay: a websocket route sent a message its `response` schema refuses')
  }
  else if (validator?.Check?.(value) === false) {
    throw new KayError('socket-reply-invalid', 'kay: a websocket route sent a message its `response` schema refuses')
  }

  const text = JSON.stringify(value)

  if (text === undefined && value !== undefined)
    throw new KayError('socket-reply-invalid', `kay: a websocket route sent ${typeof value}, which JSON cannot carry`)

  return text
}

// Elysia's websocket for the handlers of a route, its `send` and `publish` writing the protocol's frames.
function adapted(ws: ElysiaWS): ElysiaWS {
  const { raw } = ws
  const validator = (raw.data as unknown as Replying).validator

  ws.send = (value, compress) => {
    const frame = frameOf(value, validator)

    return frame === undefined ? 0 : raw.send(frame, compress)
  }
  ws.publish = (topic, value, compress) => {
    const frame = frameOf(value, validator)

    return frame === undefined ? 0 : raw.publish(topic, frame, compress)
  }

  return ws
}

// What a handler returned goes to the client as a message, each one a generator yields too.
async function answer(ws: ElysiaWS, result: unknown): Promise<void> {
  const value = await result

  if (value === undefined)
    return

  if (typeof value !== 'object' || value === null || !('next' in value) || typeof value.next !== 'function') {
    ws.send(value)

    return
  }

  for await (const part of value as unknown as AsyncIterable<unknown>)
    ws.send(part)
}

// The JSON a text frame holds; a binary frame, or text that is not JSON, holds none.
function decode(frame: string | ArrayBuffer | Uint8Array): { value: unknown } | undefined {
  if (typeof frame !== 'string')
    return undefined

  try {
    return { value: JSON.parse(frame) }
  }
  catch {
    return undefined
  }
}

function refusal(key: SocketRefusalFrame['error']['key'], fields: Record<string, string>): string {
  return JSON.stringify({ error: { key, fields } } satisfies SocketRefusalFrame)
}

// A route with no admission, run outside `serveApi`: its messages are still decoded and checked, with no limits.
const UNLIMITED = { limits: undefined, release: () => undefined, opened: () => undefined, locale: <T>(run: () => T) => run() }

// Takes the socket's frames over from Elysia once it opens, so a frame is measured before it is parsed and nothing wraps what Bun calls: the route's own message, close and open handlers run on what the protocol decoded.
// A handler's failure goes to the route's `error` hooks and the app's `onError`, as Elysia would send it, and is logged when none answers: one handler's fault closes nothing.
export async function adopt(ws: ElysiaWS, route: SocketRoute): Promise<ElysiaWS> {
  const { raw } = ws
  const data = raw.data as { message?: unknown, close?: unknown }
  const admission = admissionOf(data) ?? UNLIMITED

  adapted(ws)
  admission.opened()

  const guard = admission.limits ? frameGuard(admission.limits) : () => undefined

  async function guarded(what: string, peer: ElysiaWS, run: () => unknown): Promise<void> {
    try {
      await answer(peer, await admission.locale(run))
    }
    catch (error) {
      if (!await admission.locale(async () => route.fail?.(error, data, peer)))
        kayLog('error', `a websocket route's ${what} handler failed`, error)
    }
  }

  data.message = async (socket: ElysiaWS['raw'], frame: string | ArrayBuffer | Uint8Array) => {
    const stop = guard(frame)

    if (stop)
      return socket.close(stop.code, stop.reason)

    const decoded = decode(frame)

    if (decoded === undefined)
      return socket.send(admission.locale(() => refusal('kay.socket.notJson', { '': kayWord('kay.socket.notJson') })))

    const peer = adapted(new ElysiaWS(socket, data, decoded.value))

    await guarded('message', peer, async () => {
      const checked = route.check === undefined ? undefined : await route.check(decoded.value)

      if (checked && 'refused' in checked) {
        socket.send(refusal('kay.socket.invalid', refusedFields(checked.schema, checked.refused)))

        return undefined
      }

      const message = checked ? checked.value : decoded.value

      return route.message?.(peer, message as never)
    })
  }
  data.close = async (socket: ElysiaWS['raw'], code: number, reason: string) => {
    admission.release()
    const peer = adapted(new ElysiaWS(socket, data))

    await guarded('close', peer, () => route.close?.(peer, code, reason))
  }

  await guarded('open', ws, () => route.open?.(ws))

  return ws
}

const ADOPTED = Symbol.for('kay.socketAdopted')

interface Holding {
  server?: Upgrading | null
  [ADOPTED]?: boolean
}

interface Upgrading {
  upgrade: (request: Request, options?: { data?: object }) => boolean
}

interface Handlers {
  open?: (ws: unknown) => unknown
  message?: (ws: ElysiaWS['raw'], frame: unknown) => unknown
  close?: (...args: unknown[]) => unknown
  [ADOPTED]?: boolean
}

// Servers whose `upgrade` already holds the routes no `api()` `.ws()` made, so it is wrapped once.
const held = new WeakSet<object>()

// Holds a route no `api()` `.ws()` made, one a module built with its own `new Elysia()`, to its frame size and its connection cap: the protocol is the api's own, the limits are every route's.
// A route the api's `.ws()` made marks its context as adopted, and its socket is left as it is.
export function holdToLimits(app: Elysia): (context: Holding) => void {
  return (context) => {
    const server = context.server ?? (app as { server?: Upgrading | null }).server

    if (!server || held.has(server))
      return

    held.add(server)

    const upgrade = server.upgrade.bind(server)

    server.upgrade = (request, options) => {
      const data = options?.data as Handlers | undefined
      const admission = admissionOf(data)

      if (data && admission && !data[ADOPTED]) {
        const { open, message, close } = data
        const guard = frameGuard(admission.limits)

        data.open = (ws) => {
          admission.opened()

          return open?.(ws)
        }
        data.message = (ws, frame) => {
          const stop = guard(frame as string | ArrayBuffer | Uint8Array)

          return stop ? ws.close(stop.code, stop.reason) : message?.(ws, frame)
        }
        data.close = (...args) => {
          admission.release()

          return close?.(...args)
        }
      }

      const upgraded = upgrade(request, options)

      if (!upgraded)
        admission?.release()

      return upgraded
    }
  }
}

interface BodyCheck {
  check: NonNullable<SocketRoute['check']>
}

// The `body` of a websocket route as an HTTP route's: a message arrives cleaned and decoded, `at: '1'` as `1` for an integer, and one the schema refuses is answered with the fields it names.
// Elysia's validation is left out of the route and done here, with the validator Elysia would have built.
export function socketBody(app: Elysia, body: unknown, name: () => string): BodyCheck | undefined {
  if (body === undefined)
    return undefined

  const { definitions } = app as unknown as { definitions: { typebox: never, type: never } }
  const validator = getSchemaValidator(body as never, { modules: definitions.typebox, models: definitions.type, normalize: app.config.normalize })

  if (validator === undefined)
    return undefined

  let loggedAt = 0

  // Under `kay dev` only, and at most once a second per route: the sender is told which fields, the developer which route, in quotes as what a client sent may hold control codes.
  const refuse = (refused: ValidationError): { refused: ValidationError, schema: unknown } => {
    if (underKayDev() && performance.now() - loggedAt >= 1000) {
      loggedAt = performance.now()
      kayLog('warn', `the websocket route ${JSON.stringify(name())} refused a message of its body: ${JSON.stringify(refused.all[0]?.summary ?? 'it does not match')}`)
    }

    return { refused, schema: body }
  }

  if (validator.provider === 'standard') {
    return {
      check: async (value) => {
        const result = await (validator as unknown as { schema: { '~standard': { validate: (value: unknown) => Promise<{ issues?: never[], value?: unknown }> | { issues?: never[], value?: unknown } } } }).schema['~standard'].validate(value)

        return result.issues ? refuse(new ValidationError('message', validator, value, false, result.issues as never)) : { value: result.value }
      },
    }
  }

  return {
    check: (value) => {
      let cleaned: unknown

      // A structure the cleaner cannot walk is refused as a failed check is, never passed on unstripped.
      try {
        cleaned = validator.Clean?.(value) ?? value
      }
      catch {
        return refuse(new ValidationError('message', validator, value))
      }

      if (validator.Check(cleaned) === false)
        return refuse(new ValidationError('message', validator, cleaned))

      try {
        return { value: validator.hasTransform ? validator.Decode(cleaned) : cleaned }
      }
      catch {
        // A transform that refuses the value is a refused message too.
        return refuse(new ValidationError('message', validator, cleaned))
      }
    },
  }
}

const ADOPTS = Symbol.for('kay.socketAdopts')

// The `upgrade` option of a route made by the api's `.ws()`: it marks the context the route upgrades in, as its socket is adopted when it opens and is not held to the limits a second time, and marks itself, so the mount can tell the route from one made some other way.
function adopting(given: unknown): (context: Holding) => unknown {
  const upgrade = (context: Holding): unknown => {
    context[ADOPTED] = true

    if (typeof given === 'function')
      return (given as (context: Holding) => unknown)(context)

    if (typeof given === 'object' && given !== null)
      Object.assign((context as unknown as { set: { headers: object } }).set.headers, given)

    return undefined
  }

  Object.defineProperty(upgrade, ADOPTS, { value: true })

  return upgrade
}

// The hook holding a route to its limits, none for a route the api's `.ws()` made, which adopts its own sockets.
// Known when the module mounts, as Elysia keeps the options it was given in the route's `websocket` hook: `holdToLimits` is added only to a route that is not.
export function holdingUnlessAdopted(hooks: unknown, app: Elysia): ((context: Holding) => void)[] {
  return (hooks as { websocket?: { upgrade?: { [ADOPTS]?: boolean } } } | undefined)?.websocket?.upgrade?.[ADOPTS] === true ? [] : [holdToLimits(app)]
}

// What a websocket route may be given beside the handlers: the options of Elysia's `.ws()`, which reach it as written.
export interface SocketOptions extends SocketRoute {
  body?: unknown
  [option: string]: unknown
}

// What Elysia does with a handler's failure: the route's `error` hooks, then the app's `onError`, the first to answer sending its answer.
function failing(app: Elysia, error: unknown): NonNullable<SocketRoute['fail']> {
  return async (failure, data, ws) => {
    const hooks = [...[error ?? []].flat(), ...(app.event.error ?? []).map(hook => typeof hook === 'function' ? hook : hook.fn)] as ((context: object) => unknown)[]

    for (const hook of hooks.filter(hook => typeof hook === 'function')) {
      const answered = await hook(Object.assign(data, { error: failure }))

      if (answered !== undefined) {
        ws.send(answered)

        return true
      }
    }

    return hooks.length > 0
  }
}

// The options Elysia's `.ws()` is given in place of a route's own: it opens by adopting the socket, which then speaks the protocol, and its `body` is checked by the protocol, not by Elysia.
// `name` is the route as the app sees it, read when a refusal is logged, once the module is mounted.
export function socketOptions(app: Elysia, options: SocketOptions, name: () => string): SocketOptions {
  const { open, message, close, body } = options

  if (options.parse !== undefined)
    throw new KayError('config-invalid', `kay: the websocket route ${name()} sets \`parse\`, which a route of an api() module does not take: every frame is JSON`)

  bindReply(options.response, app)
  const route: SocketRoute = { open, message, close, check: message === undefined ? undefined : socketBody(app, body, name)?.check, fail: failing(app, options.error) }

  return {
    ...options,
    ...message !== undefined && { body: undefined },
    upgrade: adopting(options.upgrade),
    async open(ws: ElysiaWS) {
      await adopt(ws, route)
    },
  }
}
