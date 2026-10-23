import type { KayExtension } from 'kay/server'

// Mounts one Toaster and one TooltipHost on every page, outside the app's layouts. A Toaster or TooltipHost the app renders itself keeps working: only the first one mounted shows.
// Serves the routes of the `Bell` under `/_kay/ui`, and tells a template whether the visitor has an inbox as `ctx.inbox`.
export function ui(): KayExtension {
  return { name: '@kaynooo/kayjs-ui', layout: `${import.meta.dir}/shell/_layout.kay`, references: [`${import.meta.dir}/theme.css`], context: `${import.meta.dir}/context.ts`, commands: { 'ui eject': `${import.meta.dir}/eject-command.ts`, 'ui diff': `${import.meta.dir}/diff-command.ts` }, api: { dir: `${import.meta.dir}/api`, prefix: '/_kay/ui' } }
}
