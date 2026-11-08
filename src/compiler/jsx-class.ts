import type { ElementNode, NamedAttribute } from './ast'
import type { CodeBuilder } from './mapping'
import type { ClassMerge } from './plan'
import { helperName } from './markup'
import { shorthandClass } from './plan'

// What wraps a merged class list: an array on an element, the class of `componentClass` on a component, or its spread when the merge can be empty.
function mergedClassBrackets(component: boolean, asProperty: boolean): [string, string] {
  if (!component)
    return ['class={[', ']}']

  return asProperty ? [`{...${helperName('componentClass')}([`, '])}'] : [`class={${helperName('componentClass')}([`, ']).class}']
}

// JSX attribute strings have no escapes, so pick a quote the value does not contain, or fall back to an expression.
export function quoteAttribute(value: string): string {
  if (!value.includes('"'))
    return `"${value}"`

  return !value.includes('\'') ? `'${value}'` : `{${JSON.stringify(value)}}`
}

// The `.class` shorthand beside the `class` attribute of an element without spreads, as one attribute.
export function addShorthandClass(b: CodeBuilder, element: ElementNode, { attribute, shorthand: source }: ClassMerge, src: string, name: (attribute: NamedAttribute) => CodeBuilder): void {
  const shorthand = shorthandClass(element, src)

  b.add(' ')

  if (!attribute) {
    b.wrap(source!, () => b.add(`class=${quoteAttribute(shorthand)}`))

    return
  }

  if (attribute.kind === 'static') {
    b.wrap(source!, () => b.add(`class=${quoteAttribute(`${shorthand} ${attribute.text}`)}`))

    return
  }

  if (attribute.kind === 'expression') {
    // A shorthand makes the merge a non-empty string, so the `class` attribute carries it and its errors land there.
    const [open, close] = element.component ? [`${helperName('componentClass')}([`, ']).class'] : ['[', ']']

    name(attribute).add(`={${open}${JSON.stringify(shorthand)}, (`).addSource(attribute.expression).add(`)${close}}`)
  }
}

// The shorthand, the `class` attribute and the `class` each spread brings, in the order they were written.
export function addMergedClass(b: CodeBuilder, element: ElementNode, { attribute: classAttribute, shorthand }: ClassMerge, src: string): void {
  // A merge with a shorthand or a non-empty class string is always a string: it goes as the `class` attribute, where its errors are reported. One that can be empty goes as a spread, an optional property.
  const asProperty = element.component && !shorthand && !(classAttribute?.kind === 'static' && classAttribute.text.trim() !== '')

  const [open, close] = mergedClassBrackets(element.component, asProperty)

  b.add(' ')
  b.wrap(classAttribute && (classAttribute.kind === 'expression' || !shorthand) ? classAttribute.name : shorthand!, () => b.add(open))

  if (shorthand)
    b.add(JSON.stringify(shorthandClass(element, src)))

  let separator = shorthand ? ', ' : ''

  for (const attribute of element.attributes) {
    if (attribute.kind === 'spread') {
      b.add(`${separator}((`).addSource(attribute.expression).add(') as unknown as { class?: string }).class')
      separator = ', '

      continue
    }

    if (attribute !== classAttribute)
      continue

    if (attribute.kind === 'static')
      b.add(`${separator}${JSON.stringify(attribute.text)}`)
    else if (attribute.kind === 'expression')
      b.add(`${separator}(`).addSource(attribute.expression).add(')')

    separator = ', '
  }

  b.add(close)
}
