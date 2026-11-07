import type { UiSettings } from './defaults'

// Read on first use, so the icons it imports (`~icons/*`, resolved by the kay build alone) load with the app's build and not with a `kay.config.ts` importing `ui` from this package's root under plain Bun.
let loaded: UiSettings | undefined

function defaults(): UiSettings {
  // A synchronous read the bundler still follows, which a dynamic `import()` is not.
  // eslint-disable-next-line ts/no-require-imports
  loaded ??= (require('./defaults') as typeof import('./defaults')).default

  return loaded
}

export const uiDefaults: UiSettings = /* @__PURE__ */ new Proxy({} as UiSettings, {
  get: (_, key): unknown => Reflect.get(defaults(), key),
  has: (_, key) => Reflect.has(defaults(), key),
  ownKeys: () => Reflect.ownKeys(defaults()),
  getOwnPropertyDescriptor: (_, key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(defaults(), key)

    return descriptor && { ...descriptor, configurable: true }
  },
})
