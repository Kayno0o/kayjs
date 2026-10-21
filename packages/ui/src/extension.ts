import type { KayExtension } from 'kay/server'

// Mounts one Toaster and one TooltipHost on every page, outside the app's layouts. A Toaster or TooltipHost the app renders itself keeps working: only the first one mounted shows.
export function ui(): KayExtension {
  return { name: '@kaynooo/kayjs-ui', layout: `${import.meta.dir}/shell/_layout.kay` }
}
