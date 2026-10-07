import type { t as schema } from 'elysia'

// The browser's `t`: schemas are built on the server, and carrying Elysia into every island would weigh about 190 KB.
// A client build holding this message refuses to finish, naming the modules taking `t` from 'kay', so the build finds what the island would throw on.
export const t = /* @__PURE__ */ new Proxy({}, {
  get: (_, name) => {
    throw new Error(`kay: t.${String(name)}() builds a schema on the server, and kay's \`t\` is not in the browser; keep schemas in a module only the server imports`)
  },
}) as typeof schema
