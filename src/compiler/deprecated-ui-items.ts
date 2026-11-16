import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'
import { rename } from './deprecated-ui-props'

// The kayjs-ui props naming the list a component draws that are `items` since 1.105, by the library's file.
const RENAMED: Record<string, string> = {
  'ui/tabs': 'tabs',
  'ui/avatar-group': 'avatars',
  'ui/command-palette': 'entries',
  'ui/timeline': 'entries',
  'ui/side-nav': 'links',
  'ui/site-nav': 'links',
  'ui/app-header': 'links',
  'ui/steps': 'steps',
  'ui/icon-picker': 'icons',
}

type Report = (span: Span, message: string, details: Details) => void

// A kayjs-ui prop holding the list a component draws, under the name it had before 1.105 (`tabs` on Tabs, `links` on SideNav, `entries` on a CommandPalette), which is `items` on every component. Found on a component bound to the library's file; the old name works until 1.108.
export function deprecatedUiItems(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  const from = RENAMED[file]

  if (from === undefined)
    return

  const attribute = element.attributes.find((one): one is Named => one.kind !== 'spread' && text(one.name) === from)

  if (attribute === undefined)
    return

  const message = `\`${from}\` on \`${element.name}\` is \`items\` since 1.105, the name every kayjs-ui component gives the list it draws`

  if (element.attributes.some(one => one.kind !== 'spread' && text(one.name) === 'items')) {
    report(attribute.name, message, { help: `Drop \`${from}\`, \`items\` is already there` })

    return
  }

  report(attribute.name, message, { help: 'Write `items`', fixes: [{ title: 'Write `items`', safe: true, edits: [rename(attribute, from, 'items')] }] })
}
