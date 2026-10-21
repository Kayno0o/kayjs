import type { Static, TSchema } from 'elysia'
import type { Register } from './checks'

// Where the server, as it boots, and the island entry, as it loads, keep the values `publicEnv` reads.
export const PUBLIC_ENV = /* @__PURE__ */ Symbol.for('kay.publicEnv')

// What a config's `publicEnv` holds once read.
export type PublicEnvOf<Config> = Config extends { publicEnv: infer Schema extends TSchema } ? Static<Schema> : Record<never, never>

// Type only: the fields of a `defineEnv` schema marked `s.Public`, which its result carries so `kay check` can type `publicEnv` from the modules declaring them.
declare const PUBLIC_FIELDS: unique symbol

export interface WithPublicFields<Schema extends TSchema> { readonly [PUBLIC_FIELDS]: PublicFieldsOf<Schema> }

export type PublicFieldsOf<Schema extends TSchema> = Schema extends { properties: infer Fields extends Record<string, TSchema> }
  ? { [Name in keyof Static<Schema> as Name extends keyof Fields ? Fields[Name] extends { public: true } ? Name : never : never]: Static<Schema>[Name] }
  : Record<never, never>

type Intersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Joined) => void ? Joined : never

// The `s.Public` fields of every `defineEnv` result a module exports.
export type PublicFieldsOfModule<Module> = Intersection<{ [Name in keyof Module]: Module[Name] extends { readonly [PUBLIC_FIELDS]: infer Fields } ? Fields : never }[keyof Module]>

// What `publicEnv` in kay.config.ts declares, typed through `Register` by `kay check`.
export type PublicEnv = Register extends { publicEnv: infer Values extends object } ? Readonly<Values> : Readonly<Record<never, never>>

function values(): Record<string, unknown> {
  const held = (globalThis as { [PUBLIC_ENV]?: Record<string, unknown> })[PUBLIC_ENV]

  if (!held)
    throw new Error('kay: the app declares no public environment variable, in kay.config.ts or with s.Public in defineEnv')

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
