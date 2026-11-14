import type { Attribute, ElementNode } from './ast'

// The `action={...}` an element is written with.
function actionAttribute(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// `form(action={add})`: the attribute naming the action a form posts to.
export function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  return element.component || element.name !== 'form' ? undefined : actionAttribute(element, source)
}

// The `action={add}` a component is given, such as a Form: the fields in its content read that action's messages as the ones in a `form(action={add})` do.
export function componentAction(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  return element.component ? actionAttribute(element, source) : undefined
}
