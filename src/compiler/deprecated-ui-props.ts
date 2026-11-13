import type { Attribute, Details, ElementNode, Span } from './ast'
import type { ImportBinding } from './script-shared'
import { renamePackages } from '../package-names'

// A kayjs-ui or kayjs-ai component's file, as `ui/dialog` for `@kayjs/ui/dialog.kay`.
export const LIBRARY_SOURCE = /^@kayjs\/(ui|ai)\/([\w-]+)\.kay$/

// The kayjs-ui overlays whose `heading` block is `title` since 1.98, as Card's is, with `label` naming them for screen readers.
const OVERLAYS = new Set(['ui/dialog', 'ui/side-panel', 'ui/form-dialog'])
// The components whose structural `variant` is `layout` since 1.98, `variant` naming a control's frame everywhere else.
const LAYOUTS = new Set(['ui/stat', 'ai/chat', 'ai/chat-launcher'])

// The names bound to a kayjs-ui or kayjs-ai component, by the library and the component's file.
export function libraryComponents(imports: readonly ImportBinding[]): Map<string, string> {
  const found = new Map<string, string>()

  for (const binding of imports) {
    const match = binding.imported === 'default' && !binding.typeOnly ? LIBRARY_SOURCE.exec(renamePackages(binding.source)) : null

    if (match)
      found.set(binding.local, `${match[1]}/${match[2]}`)
  }

  return found
}

type Report = (span: Span, message: string, details: Details) => void

export type Named = Exclude<Attribute, { kind: 'spread' }>

// The edit renaming an attribute, which a bare `{heading}` writes out as `title={heading}`.
export function rename(attribute: Named, from: string, to: string): Span & { text: string } {
  return attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${to}={${from}}` } : { start: attribute.name.start, end: attribute.name.end, text: to }
}

// The kayjs-ui and kayjs-ai props and blocks an app still writes under the name they had before 1.98, found on a component bound to the library's file.
export function deprecatedUiProps(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  const attributes = element.attributes.filter((attribute): attribute is Named => attribute.kind !== 'spread')
  const attributeNamed = (name: string) => attributes.find(attribute => text(attribute.name) === name)
  const blockNamed = (name: string) => element.children.find(child => child.kind === 'slot' && text(child.name) === name)

  if (OVERLAYS.has(file)) {
    const title = attributeNamed('title')
    const blocked = blockNamed('title') !== undefined || attributeNamed('label') !== undefined
    const heading = attributeNamed('heading')
    const block = blockNamed('heading')
    const message = `\`heading\` on \`${element.name}\` is \`title\` since kayjs-ui 1.98, which takes a string or a \`@title\` block as a Card's does; \`label\` names it for screen readers when that differs from the visible title`

    // The string that named the dialog becomes its `label`, so the heading's markup is the title and the name stays as it was.
    const fix = (edits: (Span & { text: string })[]): Details => blocked
      ? { help: 'Drop `heading`, a `title` block or a `label` is there already' }
      : { help: 'Write `title` for the heading and `label` for the name', fixes: [{ title: 'Write `title` for the heading and `label` for the name', edits: title ? [...edits, rename(title, 'title', 'label')] : edits, safe: true }] }

    if (heading)
      report(heading.name, message, fix([rename(heading, 'heading', 'title')]))

    if (block?.kind === 'slot')
      report(block.name, message, fix([{ start: block.name.start, end: block.name.end, text: 'title' }]))
  }

  if (LAYOUTS.has(file)) {
    const variant = attributeNamed('variant')

    if (variant)
      report(variant.name, `\`variant\` on \`${element.name}\` is \`layout\` since 1.98: \`variant\` names the frame of a control, and this is how the component is laid out`, attributeNamed('layout') ? { help: 'Drop `variant`, `layout` is there' } : { help: 'Write `layout`', fixes: [{ title: 'Write `layout`', edits: [rename(variant, 'variant', 'layout')], safe: true }] })
  }
}
