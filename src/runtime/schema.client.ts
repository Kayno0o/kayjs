import type { t as schema } from 'elysia'

// The browser's `t`: schemas are built on the server, and carrying Elysia into every island would weigh about 190 KB.
export const t = /* @__PURE__ */ new Proxy({}, {
  get: (_, name) => {
    throw new Error(`kay: t.${String(name)}() builds a schema on the server, and kay's \`t\` is not in the browser; a module an island imports takes \`t\` from 'elysia'`)
  },
}) as typeof schema
