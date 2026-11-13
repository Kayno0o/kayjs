import type { KayExtension } from 'kay/server'

// Mounts one Toaster, one TooltipHost and one ConfirmHost on every page, outside the app's layouts. One the app renders itself keeps working: only one shows, the app's own before the extension's.
// Serves the routes of the `Bell` under `/_kay/ui`, and tells a template whether the visitor has an inbox as `ctx.inbox`.
export function ui(): KayExtension {
  return { name: '@kayjs/ui', layout: `${import.meta.dir}/shell/_layout.kay`, references: [`${import.meta.dir}/theme.css`], context: `${import.meta.dir}/context.ts`, commands: { 'ui eject': `${import.meta.dir}/eject-command.ts`, 'ui diff': `${import.meta.dir}/diff-command.ts` }, api: { dir: `${import.meta.dir}/api`, prefix: '/_kay/ui' } }
}
