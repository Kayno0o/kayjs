import type { Static, TSchema } from 'elysia'
import type { Register } from './checks'

// Where the server, as it boots, and the island entry, as it loads, keep the values `publicEnv` reads.
export const PUBLIC_ENV = /* @__PURE__ */ Symbol.for('kay.publicEnv')

// What a config's `publicEnv` holds once read.
export type PublicEnvOf<Config> = Config extends { publicEnv: infer Schema extends TSchema } ? Static<Schema> : Record<never, never>

// What `publicEnv` in kay.config.ts declares, typed through `Register` by `kay check`.
export type PublicEnv = Register extends { publicEnv: infer Values extends object } ? Readonly<Values> : Readonly<Record<never, never>>

function values(): Record<string, unknown> {
  const held = (globalThis as { [PUBLIC_ENV]?: Record<string, unknown> })[PUBLIC_ENV]

  if (!held)
    throw new Error('kay: kay.config.ts declares no publicEnv')

  return held
}

// Marked pure, with the symbol above, so the entry drops them when no island reads `publicEnv`: the bundler keeps a top-level call it cannot prove harmless.
// The variables kay.config.ts declares public, read from the server's environment as it boots: the one way an island reads the environment, on the server and in the browser alike.
export const publicEnv = /* @__PURE__ */ new Proxy({}, {
  get: (_target, name) => typeof name === 'string' ? values()[name] : undefined,
  has: (_target, name) => name in values(),
  ownKeys: () => Reflect.ownKeys(values()),
  getOwnPropertyDescriptor: (_target, name) => name in values() ? { value: values()[name as string], enumerable: true, configurable: true } : undefined,
}) as PublicEnv
