import type { ElementNode, FormField, Node, Span } from './ast'
import type { Markup } from './html-parts'
import type { CodeBuilder } from './mapping'
import type { ElementPlan } from './markup'
import { addFilled } from './html-initial'
import { escapeStaticAttribute, helperName } from './markup'

// The `class` of an element: written as it is when static, else built as it renders.
export function addClassAttribute(b: CodeBuilder, markup: Markup, classes: ElementPlan['classes'], classList: (classes: NonNullable<ElementPlan['classes']>) => void): void {
  if (classes?.parts) {
    const parts = classes

    markup.dynamic(() => {
      b.add(`${helperName('nonEmptyAttribute')}("class", ${helperName('className')}(`)
      classList(parts)
      b.add('))')
    })
  }
  else if (classes?.expression) {
    const { text, expression } = classes

    markup.text(' class="')
    markup.dynamic(() => b.add(`${helperName('className')}([${JSON.stringify(text)}, (`).addSource(expression).add(')])'))
    markup.text('"')
  }
  else if (classes?.pieces) {
    const { pieces } = classes

    markup.text(' class="')
    markup.dynamic(() => b.add(`${helperName('className')}(${JSON.stringify(pieces)})`))
    markup.text('"')
  }
  else if (classes) {
    markup.text(` class="${escapeStaticAttribute(classes.text)}"`)
  }
}

interface Fill {
  filled: 'value' | 'checked'
  fieldArguments: () => void
  own: (() => void) | undefined
  box: (() => void) | undefined
  values: Span | undefined
  name: string
}

// A field's `value`, or `checked` for a boolean. An input that writes no `type` takes the one its schema gives it, so which of the two it is is only known as it renders.
export function addFieldFill(b: CodeBuilder, src: string, element: ElementNode, markup: Markup, fill: Fill, field: FormField, typed: boolean): void {
  const one = (filled: 'value' | 'checked', box = fill.box) => addFilled(b, src, element, { ...fill, filled, box, own: filled === fill.filled ? fill.own : undefined, schemaType: true })

  if (!(typed && field.marked && fill.filled === 'value')) {
    markup.dynamic(() => one(fill.filled))

    return
  }

  markup.dynamic(() => {
    b.add(helperName('schemaFill'))
    fill.fieldArguments()
    b.add(', (KaySchemaType) => ')
    one('value')
    b.add(', () => ')
    one('checked', fill.own)

    // The `value` a box posts when ticked, which the template wrote.
    if (fill.own) {
      b.add(` + ${helperName('attribute')}("value", `)
      fill.own()
      b.add(')')
    }

    b.add(')')
  })
}

// The call reading the `type` the schema gives an input that writes none, for a component requiring the field to know what it is.
export function schemaTypeCall(b: CodeBuilder, element: string, type: unknown, field: FormField | undefined, target: Span | undefined): (() => void) | undefined {
  if (element !== 'input' || type !== undefined || !field?.marked || !target)
    return undefined

  return () => void b.add(`${helperName('formType')}((`).addSource(target).add(`), ${JSON.stringify(field.name)})`)
}

// Whether a `select(field=...)` writes no options, which its schema's enum gives it.
export function listsFromSchema(element: string, children: Node[], field: FormField | undefined): boolean {
  return element === 'select' && children.length === 0 && field?.marked === true
}

// The options of such a `select`, written as the helper that reads them off the schema of the action.
export function addSchemaOptions(b: CodeBuilder, target: Span, name: string): void {
  b.add(`${helperName('formOptions')}((`).addSource(target).add(`), ${JSON.stringify(name)})`)
}
