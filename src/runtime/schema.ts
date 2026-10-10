import { t as schema } from 'elysia'

// Elysia's schema builder, re-exported so an action's schema needs no import of its own.
export const s: typeof schema = schema

/** @deprecated `t` from 'kay' is `s` now, leaving `t` to translations: `s.Object({ title: s.String() })`. */
export const t: typeof schema = schema
