// Which Tailwind classes undo another: the build writes the table, the server and the island entry set it, and a class list meeting it loses the earlier classes a later one overrides.
// Each class is `[context, own, covers]`: its variants, the properties it sets and the ones it overrides, as indexes into `sets`; `covers` is left out when it equals `own`.
export interface ClassTable {
  sets: number[][]
  classes: Record<string, [context: number, own: number, covers?: number]>
}

const TABLE = Symbol.for('kay.classTable')
const WHITESPACE = /\s+/

export function installClassTable(table: ClassTable | undefined): void {
  (globalThis as { [TABLE]?: ClassTable | undefined })[TABLE] = table
}

// A class list with each class another overrides left out: one drops when a later class has the same variants and sets every property it sets.
// Classes the table does not hold, written by hand or built at runtime from parts, are never dropped.
export function resolveClasses(text: string): string {
  const table = (globalThis as { [TABLE]?: ClassTable | undefined })[TABLE]

  if (table === undefined)
    return text

  const names = text.split(WHITESPACE)

  if (names.length < 2)
    return text

  const covered = new Map<number, Set<number>>()
  const kept: string[] = []
  let dropped = false

  for (let index = names.length - 1; index >= 0; index--) {
    const name = names[index]!
    const entry = Object.hasOwn(table.classes, name) ? table.classes[name] : undefined

    if (entry === undefined) {
      kept.push(name)

      continue
    }

    const [context, own, covers = own] = entry
    const before = covered.get(context)

    if (before !== undefined && before.size > 0 && table.sets[own]!.every(property => before.has(property))) {
      dropped = true

      continue
    }

    const seen = before ?? new Set<number>()

    covered.set(context, seen)

    for (const property of table.sets[covers]!)
      seen.add(property)

    kept.push(name)
  }

  return dropped ? kept.reverse().join(' ') : text
}
