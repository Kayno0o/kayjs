import type { Attribute, ElementNode, Node, Span } from './ast'
import { actionOf, componentAction } from './form-action'
import { walkNodes } from './template-walk'

// What a form holds besides its action: the record `values={todo}` fills its fields from.
export interface FormInfo {
  values: Span | undefined
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

// The action of the innermost `form(action={...})` each node sits in; a node outside every such form has none.
// `loose` lists the nodes whose innermost form is a component given an `action` instead, whose input type `kay check` leaves alone and which an island does not wire.
// `infos` holds what that form carries beside its action.
export function formTargets(nodes: readonly Node[], source: string): { targets: Map<Node, Span>, loose: Set<Node>, infos: Map<Node, FormInfo> } {
  const targets = new Map<Node, Span>()
  const loose = new Set<Node>()
  const infos = new Map<Node, FormInfo>()

  walkNodes<{ target: Span, loose: boolean, info: FormInfo } | undefined>(nodes, undefined, (node, found) => {
    if (found) {
      targets.set(node, found.target)
      infos.set(node, found.info)

      if (found.loose)
        loose.add(node)
    }

    if (node.kind !== 'element')
      return found

    const form = actionOf(node, source) ?? componentAction(node, source)

    return form ? { target: form.expression, loose: node.component, info: { values: valuesOf(node, source)?.expression } } : found
  })

  return { targets, loose, infos }
}

// The helpers a template calls to fill its fields from the record of a form.
export function initialHelpers(infos: Map<Node, FormInfo>): ('formInitial' | 'formInitialChecked' | 'formStart')[] {
  return [...infos.values()].some(info => info.values !== undefined) ? ['formInitial', 'formInitialChecked', 'formStart'] : []
}
