// What a websocket route answers a message it refuses: the `key` of what was wrong, and the words for each field of it (`''` for the message as a whole).
export interface SocketRefusal {
  key: string
  fields: Record<string, string>
}

// A message as a websocket route sends one: always JSON, so a string, a number, a boolean and null read back as what they were. A frame that is not JSON, such as one a server outside kay sends, reads as its text.
export function readMessage(data: unknown): unknown {
  if (typeof data !== 'string')
    return data

  try {
    return JSON.parse(data)
  }
  catch {
    return data
  }
}

// The refusal a websocket route answered a message with, `{ error: { key, fields } }` with nothing else in it: a message of the route's own is never one, as its `kay.socket.*` key is the route's alone.
export function refusalOfMessage(message: unknown): SocketRefusal | undefined {
  const keys = typeof message === 'object' && message !== null ? Object.keys(message) : []
  const { error } = (keys.length === 1 ? message : {}) as { error?: Partial<SocketRefusal> | null }

  return typeof error?.key === 'string' && error.key.startsWith('kay.socket.') && typeof error.fields === 'object' && error.fields !== null ? { key: error.key, fields: error.fields } : undefined
}
