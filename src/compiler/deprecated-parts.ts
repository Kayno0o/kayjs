import type { Diagnostic, KayFile } from './ast'
import { elementsIn } from './ast'
import { oldPartsClass } from './old-parts'

// A parts object given to a component as its `class`, which is the `parts` attribute since 1.105: `class` keeps strings, arrays and objects of conditions, so the one attribute no longer has two meanings. The compiler hands a literal of the old form on as `parts` until 1.108.
export function deprecatedPartsClass(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const element of elementsIn(file.template)) {
    const attribute = oldPartsClass(element, file.source)

    if (attribute === undefined)
      continue

    const taken = element.attributes.some(one => one.kind !== 'spread' && file.source.slice(one.name.start, one.name.end) === 'parts')
    const base = { ...attribute.name, code: 'deprecated-parts-class', checkOnly: true, message: 'The parts of a component are its `parts` attribute since 1.105, `class` keeping strings, arrays and objects of conditions', help: 'write `parts={{ ... }}`, the entries of the object unchanged' }

    found.push(taken ? base : { ...base, fixes: [{ title: 'Write `parts`', safe: true, edits: [{ ...attribute.name, text: 'parts' }] }] })
  }

  return found
}
