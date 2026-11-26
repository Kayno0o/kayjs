// Island props as the server wrote them: JSON, with a tagged `{ __k, v }` for a Date, Map, Set, URL, RegExp, BigInt, non-finite number or undefined array slot.

const UNDEF = Symbol()

const REVIVERS: Record<string, (v: never) => unknown> = {
  __proto__: null as never,
  D: (v: string) => new Date(v),
  S: (v: unknown[]) => new Set(v),
  M: (v: [unknown, unknown][]) => new Map(v),
  U: (v: string) => new URL(v),
  R: ([src, flags]: [string, string]) => new RegExp(src, flags),
  B: BigInt as (v: never) => unknown,
  N: Number as (v: never) => unknown,
  u: () => UNDEF,
  O: Object.fromEntries as (v: never) => unknown,
}

export function parseIslandProps(raw: string): Record<string, unknown> {
  if (!raw.includes('"__k":'))
    return JSON.parse(raw) as Record<string, unknown>
  return JSON.parse(raw, (_k, v: unknown) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (v[i] === UNDEF)
          v[i] = undefined
      }
      return v
    }
    if (v !== null && typeof v === 'object' && '__k' in v && 'v' in v) {
      const revive = REVIVERS[(v as { __k: string }).__k]
      if (revive !== undefined)
        return revive((v as { v: never }).v)
    }
    return v
  }) as Record<string, unknown>
}
