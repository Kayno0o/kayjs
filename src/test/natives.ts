// Bun's own web classes, as they were when the test process first loaded kay/test, its preload doing so before any test file.
// A DOM a test registers, such as happy-dom's, replaces the globals in every file of the run, and Elysia reads Bun's: `headers.toJSON()` among others.
export const { Request: NativeRequest, Headers: NativeHeaders, URL: NativeURL, FormData: NativeFormData, WebSocket: NativeWebSocket, fetch: NativeFetch } = globalThis

// Every global class of Bun's, `Response` and `Event` among them, as they were then; a function such as `fetch` or a timer stays whatever the test made it, a stub included.
const CLASS_NAME = /^[A-Z]/
const natives = new Map<string, unknown>()
const scope = globalThis as unknown as Record<string, unknown>
let depth = 0
let theirs: [string, PropertyDescriptor | undefined][] = []

for (const name of Object.getOwnPropertyNames(globalThis)) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)

  if (CLASS_NAME.test(name) && descriptor !== undefined && typeof descriptor.value === 'function')
    natives.set(name, descriptor.value)
}

// Runs the app's code with Bun's own classes back over the DOM's: the server builds its requests and responses with them, and a test reads their cookies with `getSetCookie()`.
// The DOM's come back once the outermost run settles, so one that never does leaves Bun's in place.
export async function withNatives<T>(run: () => Promise<T>): Promise<T> {
  try {
    if (depth++ === 0) {
      theirs = [...natives].filter(([name, native]) => scope[name] !== native).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])

      for (const [name] of theirs)
        Object.defineProperty(globalThis, name, { value: natives.get(name), writable: true, configurable: true, enumerable: false })
    }

    return await run()
  }
  finally {
    if (--depth === 0) {
      for (const [name, descriptor] of theirs) {
        if (descriptor === undefined)
          Reflect.deleteProperty(globalThis, name)
        else
          Object.defineProperty(globalThis, name, descriptor)
      }

      theirs = []
    }
  }
}
