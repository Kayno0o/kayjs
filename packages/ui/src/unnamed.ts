const warned = new Set<string>()

// The parts of an input, select or textarea this reads, so the check holds for any element.
type Probe = Element & { labels?: ArrayLike<unknown> | null | undefined, type?: string }

// Whether something gives the control a name a screen reader announces: a label around it or pointing at it, `aria-label`, `aria-labelledby` or `title`.
function named(element: Probe): boolean {
  return (element.labels?.length ?? 0) > 0 || ['aria-label', 'aria-labelledby', 'title'].some(attribute => (element.getAttribute(attribute) ?? '').trim() !== '')
}

// Development only: warns once for each kind of field that nothing names, which a screen reader announces as its type alone. Checked a task after the field is drawn, since a label around it only counts then.
export function warnUnnamed(element: Probe): void {
  if (process.env.NODE_ENV === 'production' || (element.localName === 'input' && element.type === 'hidden'))
    return

  setTimeout(() => {
    if (!element.isConnected || named(element))
      return

    const name = element.getAttribute('name')
    const kind = element.getAttribute('role') ?? (element.localName === 'input' ? `input type="${element.type}"` : element.localName)
    const message = `kayjs-ui: a field (${kind}${name === null ? '' : ` name="${name}"`}) has no name for a screen reader: give it a \`label\` or \`aria-label\`, or put a FormField around it.`

    if (!warned.has(message)) {
      warned.add(message)
      console.warn(message)
    }
  }, 0)
}
