import type { PageSettings } from '../runtime'

// A setting of a page module: its key of `export const page`.
export function pageSetting(module: object, name: keyof PageSettings): unknown {
  return (module as { page?: PageSettings }).page?.[name]
}
