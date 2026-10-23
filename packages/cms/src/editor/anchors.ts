import type { Field } from '../fields'
import type { FormLayout } from '../kay/contract'
import type { FieldPath } from '../markers'
import { wording } from 'kay/words'
import { BODY_ID, formRows } from '../layout'
import { BODY } from '../markers'

export interface Anchor {
  // The path the form's item is edited at, `#body` for the Markdown body.
  key: string
  label: string
}

// The form's items in the order it draws them, each named by its label: what the editor jumps to when the form is collapsed to one field.
export function anchorsOf(fields: Field[], hasBody: boolean, layout?: FormLayout): Anchor[] {
  return formRows(fields, hasBody, layout).flat().map(item => item === 'body' ? { key: BODY_ID, label: layout?.body?.label ?? wording('cms.entry.body', 'Body') } : { key: item.at ?? String(item.key), label: item.label })
}

// The name a path on the page has among the form's items: the body's is the item's `#body`.
export const keyOfPath = (path: FieldPath): string => path === BODY ? BODY_ID : path

// The item of the form holding the field a path names: the item of that path or the longest one it lies inside (a list's item, a group's field, the group a placed field was taken from), else none, as for a field the layout hides.
export function ownerOf(anchors: readonly Anchor[], path: string): string | undefined {
  let owner: string | undefined

  for (const { key } of anchors) {
    if ((key === path || path.startsWith(`${key}.`)) && (owner === undefined || key.length > owner.length))
      owner = key
  }

  return owner
}
