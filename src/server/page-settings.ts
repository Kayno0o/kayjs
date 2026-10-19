import type { PageSettings } from '../runtime'

// A setting of a page module: its key of `export const page`.
export function pageSetting(module: object, name: keyof PageSettings): unknown {
  return (module as { page?: PageSettings }).page?.[name]
}

// A setting along a route's modules, layouts outermost first and the page last: the innermost that sets it wins, so a page may undo what its layouts say.
export function chainSetting(modules: object[], name: keyof PageSettings): unknown {
  for (let index = modules.length - 1; index >= 0; index--) {
    const value = pageSetting(modules[index]!, name)

    if (value !== undefined)
      return value
  }

  return undefined
}
