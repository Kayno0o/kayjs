// `bytes` random bytes as lowercase hex, `2 * bytes` characters. Works on the server and on an insecure page, where `crypto.randomUUID` is missing but `getRandomValues` is not.
// kept: request, it draws a new value on every call, as the clock does.
export function randomId(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
