import type { Elysia } from 'elysia'
import type { Admission } from './ws-limits'
import { getSchemaValidator, ValidationError } from 'elysia'
import { ElysiaWS } from 'elysia/ws'
import { underKayDev } from '../build/assets'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { refusedFields } from './field-errors'
import { kayWord } from './words'
import { admissionOf, frameGuard } from './ws-limits'

// The protocol of a websocket route: every frame is JSON, in both directions, so a string, a number, a boolean or `null` reads back as what it was.
// A message the route refuses is answered `{ error: { key, fields } }`, `key` naming what was wrong and `fields` the words for each field, never the schema.
export interface SocketRefusal {
  error: { key: 'kay.socket.notJson' | 'kay.socket.invalid', fields: Record<string, string> }
}

// What a route hands the protocol: the handlers of its options, and what the route knows of itself.
export interface SocketRoute {
  open?: ((ws: Peer) => unknown) | undefined
  message?: ((ws: Peer, message: never) => unknown) | undefined
  close?: ((ws: Peer, code: number, reason: string) => unknown) | undefined
  // Checks a decoded message against the route's `body`, answering what the handler gets or why it is refused.
  check?: ((message: unknown) => Checked) | undefined
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

function refusal(key: SocketRefusal['error']['key'], fields: Record<string, string>): string {
  return JSON.stringify({ error: { key, fields } } satisfies SocketRefusal)
}

// Runs a handler in the request's locale, a failure reported and the socket left as it was: one handler's fault closes nothing.
async function guarded(admission: Admission, what: string, run: () => unknown): Promise<unknown> {
  try {
    return await admission.locale(run)
  }
  catch (error) {
    kayLog('error', `a websocket route's ${what} handler failed`, error)

    return undefined
  }
}

// Takes the socket's frames over from Elysia once it opens, so a frame is measured before it is parsed and nothing wraps what Bun calls: the route's own message, close and open handlers run on what the protocol decoded.
export function adopt(ws: ElysiaWS, route: SocketRoute): ElysiaWS {
  const { raw } = ws
  const data = raw.data as { message?: unknown, close?: unknown }
  const admission = admissionOf(data)

  adapted(ws)

  if (!admission)
    return ws

  admission.opened()

  const guard = frameGuard(admission.limits)

  data.message = async (socket: ElysiaWS['raw'], frame: string | ArrayBuffer | Uint8Array) => {
    const stop = guard(frame)

    if (stop)
      return socket.close(stop.code, stop.reason)

    const decoded = decode(frame)

    if (decoded === undefined)
      return socket.send(admission.locale(() => refusal('kay.socket.notJson', { '': kayWord('kay.socket.notJson') })))

    await guarded(admission, 'message', async () => {
      let message = decoded.value
      const checked = route.check === undefined ? undefined : await route.check(message)

      if (checked && 'refused' in checked) {
        socket.send(refusal('kay.socket.invalid', refusedFields(checked.schema, checked.refused)))

        return
      }

      if (checked)
        message = checked.value

      const peer = adapted(new ElysiaWS(socket, data, message))

      await answer(peer, route.message?.(peer, message as never))
    })
  }
  data.close = async (socket: ElysiaWS['raw'], code: number, reason: string) => {
    admission.release()
    await guarded(admission, 'close', () => route.close?.(adapted(new ElysiaWS(socket, data)), code, reason))
  }

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

      return upgrade(request, options)
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

// What a websocket route may be given beside the handlers: the options of Elysia's `.ws()`, which reach it as written.
export interface SocketOptions extends SocketRoute {
  body?: unknown
  [option: string]: unknown
}

// The options Elysia's `.ws()` is given in place of a route's own: it opens by adopting the socket, which then speaks the protocol, and its `body` is checked by the protocol, not by Elysia.
// `name` is the route as the app sees it, read when a refusal is logged, once the module is mounted.
export function socketOptions(app: Elysia, options: SocketOptions, name: () => string): SocketOptions {
  const { open, message, close, body } = options
  const route: SocketRoute = { open, message, close, check: message === undefined ? undefined : socketBody(app, body, name)?.check }

  return {
    ...options,
    ...message !== undefined && { body: undefined },
    // Marks the context the route upgrades in: the socket is adopted when it opens, so it is not held to the limits a second time.
    upgrade(context: Holding) {
      context[ADOPTED] = true

      if (typeof options.upgrade === 'function')
        return (options.upgrade as (context: Holding) => unknown)(context)

      if (typeof options.upgrade === 'object')
        Object.assign((context as unknown as { set: { headers: object } }).set.headers, options.upgrade)

      return undefined
    },
    async open(ws: ElysiaWS) {
      adopt(ws, route)

      const admission = admissionOf(ws.raw.data)

      await answer(ws, admission === undefined ? open?.(ws) : await guarded(admission, 'open', () => open?.(ws)))
    },
  }
}
