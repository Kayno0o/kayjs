import type { s as server } from './schema'

const INERT = 'kay: a schema is inert in the browser: it validates on the server, so read its type with `Static<typeof SCHEMA>` and check values there'

// What a builder returns in the browser: it passes into another builder, but any read of it throws.
// `then` and `toJSON` stay undefined so awaiting or serializing one is not the first read to fail.
const schema: object = /* @__PURE__ */ new Proxy({}, {
  get: (_, key) => {
    if (typeof key === 'symbol' || key === 'then' || key === 'toJSON')
      return undefined

    throw new Error(INERT)
  },
})

const build = () => schema

// The browser's `s`: a module shared with the server may build its schemas as it loads, and they cost nothing here, as carrying Elysia into every island would weigh about 190 KB.
export const s = /* @__PURE__ */ new Proxy({}, {
  get: (_, name) => typeof name === 'symbol' || name === 'then' ? undefined : build,
}) as typeof server
