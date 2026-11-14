import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'
import { rename } from './deprecated-ui-props'

interface Renamed {
  from: string
  to: string
  // The fields of the event the new name's callback takes, in the order the old callback took its arguments.
  fields: readonly string[]
}

const CHARTS = ['ui/bar-chart', 'ui/line-chart', 'ui/scatter-chart', 'ui/sparkline', 'ui/contribution-graph']

// The kayjs-ui props whose callback took positional arguments under another name, by the library's file.
const RENAMED: Record<string, Renamed> = {
  'ui/accordion': { from: 'onChange', to: 'onValueChange', fields: ['value'] },
  'ui/tabs': { from: 'onChange', to: 'onValueChange', fields: ['value', 'tab'] },
  'ui/theme-toggle': { from: 'onChange', to: 'onValueChange', fields: ['value', 'option'] },
  'ui/zoom-pane': { from: 'onChange', to: 'onPlateChange', fields: ['plate'] },
  'ui/table': { from: 'onSort', to: 'onSortChange', fields: ['sort'] },
  ...Object.fromEntries(CHARTS.map(file => [file, { from: 'onActive', to: 'onActiveChange', fields: ['index'] }])),
}

// `value =>`, `(value) =>` and `(value, tab) =>`: the arrow functions whose parameters are plain names, which the event object destructures under the same names.
const ARROW = /^(?:\(\s*(\w+)(?:\s*,\s*(\w+))?\s*\)|(\w+))\s*=>/

type Report = (span: Span, message: string, details: Details) => void

// A kayjs-ui prop whose callback takes one event object since 1.105, under a new name where the old one hid what it carried (`onChange` on Tabs, `onSort` on Table, `onActive` on a chart). Found on a component bound to the library's file; an inline arrow with plain parameter names is rewritten to destructure the event, any other value gets the new name only.
export function deprecatedUiCallbacks(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  const renamed = RENAMED[file]

  if (renamed === undefined)
    return

  const attribute = element.attributes.find((one): one is Named => one.kind !== 'spread' && text(one.name) === renamed.from)

  if (attribute === undefined)
    return

  const message = `\`${renamed.from}\` on \`${element.name}\` is \`${renamed.to}\` since 1.105, and its callback takes one event object: \`{ ${renamed.fields.join(', ')} }\``
  const edits = [rename(attribute, renamed.from, renamed.to)]
  const arrow = attribute.kind === 'expression' && !attribute.shorthand ? ARROW.exec(text(attribute.expression).trimStart()) : null
  const names = arrow?.slice(1).filter(name => name !== undefined) ?? []

  if (attribute.kind === 'expression' && arrow !== null && names.length <= renamed.fields.length) {
    const parameters = names.map((name, index) => name === renamed.fields[index] ? name : `${renamed.fields[index]}: ${name}`)
    const start = attribute.expression.start + (text(attribute.expression).length - text(attribute.expression).trimStart().length)

    edits.push({ start, end: start + arrow[0].length - '=>'.length, text: `({ ${parameters.join(', ')} }) ` })

    report(attribute.name, message, { help: `Write \`${renamed.to}\` and destructure the event`, fixes: [{ title: `Write \`${renamed.to}\` and destructure the event`, safe: true, edits }] })

    return
  }

  report(attribute.name, message, { help: `Write \`${renamed.to}\` and take the event object`, fixes: [{ title: `Write \`${renamed.to}\`, then take the event object`, safe: false, edits }] })
}
