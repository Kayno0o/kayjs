// What a browser lets its `keepalive` requests carry, all in flight together. Only a text body is measured: a form may hold files of any size.
const KEEPALIVE_LIMIT = 64 * 1024

let held = 0

// Runs `send` with `{ keepalive: true }` when the call asked for it and its text body fits in what the calls in flight leave of the cap, else with nothing, as a plain post: a browser rejects a keepalive request past the cap whole.
export async function withKeepalive<Result>(wanted: boolean, body: unknown, send: (extra?: { keepalive: true }) => Promise<Result>): Promise<Result> {
  const size = wanted && typeof body === 'string' ? new TextEncoder().encode(body).byteLength : Number.POSITIVE_INFINITY

  if (held + size > KEEPALIVE_LIMIT)
    return send()

  held += size

  try {
    return await send({ keepalive: true })
  }
  finally {
    held -= size
  }
}
