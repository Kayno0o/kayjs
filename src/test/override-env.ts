// What `overrideEnv` takes: any of the env's variables, `undefined` unsetting an optional one.
export type EnvOverride<Env extends object> = { [Name in keyof Env]?: Env[Name] | undefined }

export interface EnvRestore {
  restore: () => void
  [Symbol.dispose]: () => void
}

// Gives variables of a `defineEnv` value another value, which every module reading that `env` sees at once, `restore()` (or the end of a `using`) putting back what it held.
// Values are not read against the schema again, and overrides undone in the order they were made.
export function overrideEnv<Env extends object>(env: Env, values: EnvOverride<Env>): EnvRestore {
  const before = new Map<string, PropertyDescriptor | undefined>()
  let restored = false

  for (const [name, value] of Object.entries(values)) {
    before.set(name, Object.getOwnPropertyDescriptor(env, name))

    if (value === undefined)
      Reflect.deleteProperty(env, name)
    else
      Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true })
  }

  const restore = (): void => {
    if (restored)
      return

    restored = true

    for (const [name, descriptor] of before) {
      if (descriptor === undefined)
        Reflect.deleteProperty(env, name)
      else
        Object.defineProperty(env, name, descriptor)
    }
  }

  return { restore, [Symbol.dispose]: restore }
}
