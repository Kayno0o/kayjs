import type { Attribute, ElementNode, NamedAttribute, Node, Span } from './ast'
import { FIELD_ATTRIBUTE, FIELD_ELEMENTS } from './ast'
import { actionOf, componentAction } from './form-action'
import { visitNodes, walkNodes } from './template-walk'

const WHITESPACE = /\s+/g
const ID_UNSAFE = /[^\w-]+/g
const NO_NAMES: ReadonlyMap<string, number> = new Map()

// What a form holds besides its action: the record `values={todo}` fills its fields from, and the fields its `label(field=...)` lines name, each with the number of controls in the form that carry that name.
export interface FormInfo {
  values: Span | undefined
  labelled: ReadonlyMap<string, number>
}

// The id a `label(field="title")` points at and the control of that field takes, from the action of the form the two sit in: `save-title`.
export function fieldIdOf(action: string, field: string): string {
  return `${action.replace(WHITESPACE, '').replace(ID_UNSAFE, '-')}-${field.replace(ID_UNSAFE, '-')}`
}

// The name a component's `field="title"` gives the bare controls written in its content: a `FormField(field="title")` around an `input`.
export interface FieldContent {
  name: string
  at: Extract<NamedAttribute, { kind: 'static' }>
}

// The `values={todo}` of a form posting to an action, or of a component given an `action`.
export function valuesOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.name !== 'form' && !element.component)
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'values')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// A call with arguments, or a group: a signal read, `todo()`, is a call with none.
const CALL = /\((?!\))/

// Whether `attribute` is the `values` of a form and calls a function, which every field of the form would run: each reads the record on its own.
export function valuesCall(element: ElementNode, attribute: Attribute, source: string): attribute is Extract<Attribute, { kind: 'expression' }> {
  return attribute.kind === 'expression' && valuesOf(element, source) === attribute && CALL.test(source.slice(attribute.expression.start, attribute.expression.end))
}

// The component whose `field` names its controls: kayjs-ui's. Any other component's `field` is its own prop.
export const FIELD_COMPONENT = 'FormField'

// The `field` a FormField is given: the name its bare controls take when it is static text, none when it is computed, and `fallback` for a component with none or one that is not a FormField.
function fieldOfComponent(element: ElementNode, source: string, fallback: FieldContent | undefined): FieldContent | undefined {
  if (element.name !== FIELD_COMPONENT)
    return fallback

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === FIELD_ATTRIBUTE)

  if (!attribute)
    return fallback

  return attribute.kind === 'static' ? { name: attribute.text, at: attribute } : undefined
}

// The static `field="..."` or `name="..."` of an element.
export function writtenName(element: ElementNode, source: string, ...attributes: string[]): string | undefined {
  const found = element.attributes.find(candidate => candidate.kind === 'static' && attributes.includes(source.slice(candidate.name.start, candidate.name.end)))

  return found?.kind === 'static' ? found.text : undefined
}

// The fields a form's `label(field="...")` lines name, with how many controls of the form carry each name: the control of a field named once takes the id its label points to.
function labelledFields(element: ElementNode, source: string): ReadonlyMap<string, number> {
  const labels = new Set<string>()
  const controls: string[] = []

  visitNodes(element.children, (node) => {
    if (node.kind !== 'element' || node.component)
      return

    if (node.name === 'label') {
      const name = writtenName(node, source, FIELD_ATTRIBUTE)

      if (name !== undefined)
        labels.add(name)
    }
    // A control with a spread takes no id, nor does its `field` write a `name`, so it is none of the field's.
    else if (FIELD_ELEMENTS.has(node.name) && !node.attributes.some(attribute => attribute.kind === 'spread')) {
      const name = writtenName(node, source, 'name', FIELD_ATTRIBUTE)

      // A control naming itself with `name` and keeping its own id is not the one the label points at; one with `field` has its own message.
      if (name !== undefined && (writtenName(node, source, FIELD_ATTRIBUTE) !== undefined || !hasId(node, source)))
        controls.push(name)
    }
  })

  return labels.size === 0 ? NO_NAMES : new Map([...labels].map(name => [name, controls.filter(control => control === name).length]))
}

function hasId(element: ElementNode, source: string): boolean {
  return element.id !== undefined || element.attributes.some(attribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'id')
}

// Whether a control writes neither `name` nor `field`, so the component around it may name it.
export function isBareControl(element: ElementNode, source: string): boolean {
  return !element.component && FIELD_ELEMENTS.has(element.name) && !element.attributes.some(attribute => attribute.kind === 'spread' || ['name', FIELD_ATTRIBUTE].includes(source.slice(attribute.name.start, attribute.name.end)))
}

// The action of the innermost `form(action={...})` each node sits in; a node outside every such form has none.
// `loose` lists the nodes whose innermost form is a component given an `action` instead, whose input type `kay check` leaves alone and which an island does not wire.
// `infos` holds what that form carries beside its action, and `inherited` the field a component around a node names for it.
export function formTargets(nodes: readonly Node[], source: string): { targets: Map<Node, Span>, loose: Set<Node>, infos: Map<Node, FormInfo>, inherited: Map<Node, FieldContent> } {
  const targets = new Map<Node, Span>()
  const loose = new Set<Node>()
  const infos = new Map<Node, FormInfo>()
  const inherited = new Map<Node, FieldContent>()

  walkNodes<{ target: Span, loose: boolean, info: FormInfo, field: FieldContent | undefined } | undefined>(nodes, undefined, (node, found) => {
    if (found) {
      targets.set(node, found.target)
      infos.set(node, found.info)

      if (found.field)
        inherited.set(node, found.field)

      if (found.loose)
        loose.add(node)
    }

    if (node.kind !== 'element')
      return found

    const form = actionOf(node, source) ?? componentAction(node, source)

    if (form)
      return { target: form.expression, loose: node.component, info: { values: valuesOf(node, source)?.expression, labelled: labelledFields(node, source) }, field: undefined }

    if (found && node.name === 'form' && !node.component)
      return { ...found, field: undefined }

    return found && node.component ? { ...found, field: fieldOfComponent(node, source, found.field) } : found
  })

  // A bare control a component names counts for that name in its form, as one written with it does.
  for (const [node, content] of inherited) {
    const labelled = infos.get(node)?.labelled as Map<string, number> | undefined

    if (node.kind === 'element' && isBareControl(node, source) && !hasId(node, source) && labelled?.has(content.name))
      labelled.set(content.name, labelled.get(content.name)! + 1)
  }

  return { targets, loose, infos, inherited }
}

// The helpers a template calls to fill its fields from the record of a form.
export function initialHelpers(infos: Map<Node, FormInfo>): ('formInitial' | 'formInitialChecked' | 'formStart')[] {
  return [...infos.values()].some(info => info.values !== undefined) ? ['formInitial', 'formInitialChecked', 'formStart'] : []
}
