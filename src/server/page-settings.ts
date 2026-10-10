import type { PageSettings } from '../runtime'

// A setting of a page module: its key of `export const page`, else its export of its own name, as settings were written before `page`.
export function pageSetting(module: object, name: keyof PageSettings): unknown {
  const page = (module as { page?: unknown }).page

  return typeof page === 'object' && page !== null && name in page ? (page as PageSettings)[name] : (module as PageSettings)[name]
}
