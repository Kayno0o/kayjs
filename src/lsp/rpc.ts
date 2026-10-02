type Id = number | string

export interface Message {
  jsonrpc: '2.0'
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number, message: string }
}

type RequestHandler = (params: never) => unknown
type NotificationHandler = (params: never) => void

const HEADER_END = '\r\n\r\n'
const CONTENT_LENGTH = /content-length: *(\d+)/i
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

export class ResponseError extends Error {
  override name = 'ResponseError'

  constructor(readonly code: number, message: string) {
    super(message)
  }
}

// JSON-RPC over a byte stream with LSP's `Content-Length` framing, used both towards the editor and towards tsgo.
export class Connection {
  readonly closed: Promise<void>
  private nextId = 0
  private readonly pending = new Map<Id, { resolve: (result: unknown) => void, reject: (error: Error) => void }>()
  private readonly requests = new Map<string, RequestHandler>()
  private readonly notifications = new Map<string, NotificationHandler>()
  private unhandledRequest: (method: string, params: unknown) => unknown = (method) => {
    throw new ResponseError(METHOD_NOT_FOUND, `Unhandled method ${method}`)
  }

  constructor(input: ReadableStream<Uint8Array>, private readonly write: (data: string) => void) {
    this.closed = this.listen(input)
  }

  request<Result>(method: string, params?: unknown): Promise<Result> {
    const id = ++this.nextId

    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  onRequest<Params>(method: string, handler: (params: Params) => unknown): void {
    this.requests.set(method, handler as RequestHandler)
  }

  onNotification<Params>(method: string, handler: (params: Params) => void): void {
    this.notifications.set(method, handler as NotificationHandler)
  }

  onUnhandledRequest(handler: (method: string, params: unknown) => unknown): void {
    this.unhandledRequest = handler
  }

  private send(message: Message) {
    const body = JSON.stringify(message)

    this.write(`Content-Length: ${Buffer.byteLength(body)}${HEADER_END}${body}`)
  }

  private async listen(input: ReadableStream<Uint8Array>) {
    let buffer: Buffer = Buffer.alloc(0)

    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, chunk])

      for (let message = takeMessage(buffer); message; message = takeMessage(buffer)) {
        buffer = message.rest
        this.dispatch(JSON.parse(message.body) as Message)
      }
    }

    for (const { reject } of this.pending.values())
      reject(new Error('Connection closed'))
    this.pending.clear()
  }

  private dispatch(message: Message) {
    if (message.method === undefined) {
      this.settle(message)

      return
    }

    if (message.id === undefined || message.id === null) {
      this.notifications.get(message.method)?.(message.params as never)

      return
    }

    void this.answer(message.id, message.method, message.params)
  }

  private settle(message: Message) {
    const pending = message.id === undefined || message.id === null ? undefined : this.pending.get(message.id)

    if (!pending)
      return

    this.pending.delete(message.id!)

    if (message.error)
      pending.reject(new ResponseError(message.error.code, message.error.message))
    else
      pending.resolve(message.result ?? null)
  }

  private async answer(id: Id, method: string, params: unknown) {
    const handler = this.requests.get(method)

    try {
      const result = await (handler ? handler(params as never) : this.unhandledRequest(method, params))

      this.send({ jsonrpc: '2.0', id, result: result ?? null })
    }
    catch (error) {
      const code = error instanceof ResponseError ? error.code : INTERNAL_ERROR

      this.send({ jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

function takeMessage(buffer: Buffer): { body: string, rest: Buffer } | undefined {
  const headerEnd = buffer.indexOf(HEADER_END)

  if (headerEnd === -1)
    return undefined

  const length = Number(CONTENT_LENGTH.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1] ?? 0)
  const start = headerEnd + HEADER_END.length

  if (buffer.length < start + length)
    return undefined

  return { body: buffer.subarray(start, start + length).toString('utf8'), rest: buffer.subarray(start + length) }
}
