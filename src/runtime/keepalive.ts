// What a browser lets a `keepalive` request carry. Only a text body is measured: a form may hold files of any size.
const KEEPALIVE_LIMIT = 64 * 1024

// Whether a call asking for `keepalive` may send it: a text body within the cap, else the call goes as a plain post.
export function fits(body: unknown): boolean {
  return typeof body === 'string' && new TextEncoder().encode(body).byteLength <= KEEPALIVE_LIMIT
}
