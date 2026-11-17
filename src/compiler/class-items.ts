// A source of a merged class: a literal kept as text, so the ones side by side resolve together, or code that writes the value.
export type ClassItem = { text: string } | { emit: () => void }

// The items with each run of literals side by side joined into one.
export function joinTexts(items: ClassItem[], join: (texts: string[]) => string): ClassItem[] {
  return items.reduce<ClassItem[]>((merged, item) => {
    const last = merged.at(-1)

    if ('text' in item && last !== undefined && 'text' in last)
      merged[merged.length - 1] = { text: join([last.text, item.text]) }
    else
      merged.push(item)

    return merged
  }, [])
}
