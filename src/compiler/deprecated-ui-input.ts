import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'

// The kayjs-ui controls whose spread attributes went to their input before 1.105 and go to their root now, with the attributes that stay the input's own (`id` is not one on a Combobox, where it names the list).
const CONTROLS = new Set(['ui/toggle', 'ui/checkbox', 'ui/slider', 'ui/color-input', 'ui/combobox', 'ui/date-input'])

// A tooltip stays with the input, which the keyboard reaches.
const TOOLTIP = /^data-(?:tooltip|hint)/
const isRootAttribute = (name: string, file: string) => (name === 'id' && file !== 'ui/combobox') || name === 'title' || (name.startsWith('data-') && !TOOLTIP.test(name))

type Report = (span: Span, message: string, details: Details) => void

// Where an attribute ends, its closing quote or brace included.
function attributeEnd(attribute: Named): number {
  if (attribute.kind === 'static')
    return attribute.value.end + 1

  return attribute.kind === 'expression' ? attribute.shorthand?.end ?? attribute.expression.end + 1 : attribute.name.end
}

// What an attribute holds, written as a property value of an object literal.
function propertyValue(attribute: Named, text: (span: Span) => string): string {
  if (attribute.kind === 'static')
    return JSON.stringify(attribute.text)

  return attribute.kind === 'expression' ? text(attribute.expression).trim() : '\'\''
}

const IDENTIFIER = /^[a-z_$][\w$]*$/i
const propertyKey = (name: string) => IDENTIFIER.test(name) ? name : JSON.stringify(name)

// The edit writing `inputProps` into the brackets of an element with none to rewrite, which has none when it is written `Toggle#id` alone.
function insertion(element: ElementNode, object: string, others: boolean): (Span & { text: string })[] {
  const at = element.parens ? element.parens.start + 1 : undefined

  return at === undefined ? [] : [{ start: at, end: at, text: others ? `${object} ` : object }]
}

// Where an attribute starts, its brace included when it is written as a shorthand.
const attributeStart = (attribute: Named) => attribute.kind === 'expression' && attribute.shorthand ? attribute.shorthand.start : attribute.name.start

const SPACE = /\s/

// The edit taking an attribute out with the white space before it.
function removal(attribute: Named, text: (span: Span) => string): Span & { text: string } {
  let start = attributeStart(attribute)

  while (start > 0 && SPACE.test(text({ start: start - 1, end: start })))
    start--

  return { start, end: attributeEnd(attribute), text: '' }
}

// The `id`, `title` and `data-*` attributes of a kayjs-ui control that drew an input (Toggle, Checkbox, Slider, ColorInput, Combobox, DateInput), the `#id` shorthand among them, which reached its input before 1.105 and reach its root now, the input taking `inputProps`. The fix gathers them into one `inputProps` object, and offers none beside an `inputProps` already written.
export function deprecatedUiInput(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  if (!CONTROLS.has(file))
    return

  const attributes = element.attributes.filter((one): one is Named => one.kind !== 'spread')
  const moved = attributes.filter(one => isRootAttribute(text(one.name), file))
  const shorthand = file === 'ui/combobox' ? undefined : element.id

  if (moved.length === 0 && shorthand === undefined)
    return

  const written = attributes.some(one => text(one.name) === 'inputProps')
  const entries = [
    ...shorthand && !moved.some(one => text(one.name) === 'id') ? [`id: ${JSON.stringify(text(shorthand))}`] : [],
    ...moved.map(one => `${propertyKey(text(one.name))}: ${propertyValue(one, text)}`),
  ]
  const object = `inputProps={{ ${entries.join(', ')} }}`
  // One fix rewrites them all, as each of the others alone would lose its attribute: the object goes where the first attribute was, or into the brackets when only `#id` is there.
  const edits = moved.length > 0 ? [{ start: attributeStart(moved[0]!), end: attributeEnd(moved[0]!), text: object }, ...moved.slice(1).map(one => removal(one, text))] : insertion(element, object, attributes.length > 0)

  if (shorthand)
    edits.push({ start: shorthand.start - 1, end: shorthand.end, text: moved.length === 0 && !element.parens ? `(${object})` : '' })

  const message = (name: string) => `\`${name}\` on \`${element.name}\` is on its root since 1.105, as on every kayjs-ui component; the input takes \`inputProps\``
  const reports: { span: Span, name: string }[] = [
    ...shorthand ? [{ span: { start: shorthand.start - 1, end: shorthand.end }, name: '#id' }] : [],
    ...moved.map(one => ({ span: one.name, name: text(one.name) })),
  ]

  for (const [index, { span, name }] of reports.entries()) {
    if (written)
      report(span, message(name), { help: `Move \`${name}\` into \`inputProps\`` })
    else if (index > 0)
      report(span, message(name), { help: 'The first one\'s fix writes them all into `inputProps`' })
    else
      report(span, message(name), { help: 'Write `inputProps`', fixes: [{ title: 'Write `inputProps`', safe: true, edits }] })
  }
}
