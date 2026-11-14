import type { Attribute, ElementNode, NamedAttribute, Node, Span } from './ast'
import { actionOf, componentAction, FIELD_ATTRIBUTE, visitNodes, walkNodes } from './ast'

// What a form holds besides its action, for the fields written in it: the record `values={todo}` fills them from, and the names of its `label(field=...)` lines, whose controls take the id they point to.
export interface FormInfo {
  values: Span | undefined
  labelled: ReadonlySet<string>
}

// The name a component's `field="title"` gives the bare controls written in its content: a `FormField(field="title")` around an `input`.
export interface FieldContent {
  name: string
  at: NamedAttribute
}

const NO_NAMES: ReadonlySet<string> = new Set()

// The `values={todo}` of a form posting to an action, or of a component given an `action`.
export function valuesOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.name !== 'form' && !element.component)
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'values')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// The static `field="title"` a component is given: the name its bare controls take.
function fieldOfComponent(element: ElementNode, source: string): FieldContent | undefined {
  if (!element.component)
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind === 'static' && source.slice(candidate.name.start, candidate.name.end) === FIELD_ATTRIBUTE)

  return attribute?.kind === 'static' ? { name: attribute.text, at: attribute } : undefined
}

// The fields a form's `label(field="...")` lines name.
function labelledFields(element: ElementNode, source: string): ReadonlySet<string> {
  const names = new Set<string>()

  visitNodes(element.children, (node) => {
    if (node.kind !== 'element' || node.component || node.name !== 'label')
      return

    const attribute = node.attributes.find(candidate => candidate.kind === 'static' && source.slice(candidate.name.start, candidate.name.end) === FIELD_ATTRIBUTE)

    if (attribute?.kind === 'static')
      names.add(attribute.text)
  })

  return names.size === 0 ? NO_NAMES : names
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

    return found && node.component ? { ...found, field: fieldOfComponent(node, source) ?? found.field } : found
  })

  return { targets, loose, infos, inherited }
}

// The helpers a template calls to fill its fields from the record of a form.
export function initialHelpers(infos: Map<Node, FormInfo>): ('formInitial' | 'formInitialChecked')[] {
  return [...infos.values()].some(info => info.values !== undefined) ? ['formInitial', 'formInitialChecked'] : []
}
