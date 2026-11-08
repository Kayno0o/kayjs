// A tab of the dev tool as Markdown, to paste into an issue or to an LLM. Split from dev-tool.ts, which the dev server serves with the modules it imports.

// What the Markdown of a tab leaves out: its controls, drawings, the Head previews that repeat its tags, and what is hidden.
const UNCOPIED = '.toolbar, .actions, .copy, .dismiss, .previews, .scalebox, img, svg, .rule, [hidden], [data-filtered]'
// Elements a line of text runs through, rather than blocks of their own.
const INLINE = new Set(['a', 'b', 'button', 'code', 'i', 'small', 'span', 'strong'])
const BULLET = /^ *- /
const SPACES = /\s+/g

// The text of an element, its parts spaced as they are drawn apart, and what the Markdown leaves out skipped.
function spacedText(element: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '')

      return
    }

    if (node instanceof Element && node.matches(UNCOPIED))
      return

    // An element stands apart from the text around it, as a pill after a heading's words.
    for (const child of node.childNodes) {
      if (child instanceof Element)
        parts.push(' ')

      walk(child)

      if (child instanceof Element)
        parts.push(' ')
    }
  }

  walk(element)

  return parts.join('').replace(SPACES, ' ').trim()
}

function fenced(text: string): string {
  const fence = text.includes('```') ? '````' : '```'

  return `${fence}text\n${text}\n${fence}`
}

// What a tab shows, as Markdown to paste into an issue or an LLM: headings, facts and table rows as bullets, a row of a list with its chips, problems and note, problems and code as fenced blocks; the filter and buttons are left out, and so is what it hides.
export function panelMarkdown(panel: Element, title: string): string {
  const lines: string[] = [`# ${title}`]
  const block = (element: Element) => {
    if (element.matches(UNCOPIED))
      return

    const tag = element.localName
    const kind = element.classList

    if (tag === 'h3') {
      lines.push(`## ${spacedText(element)}`)
    }
    else if (tag === 'dl') {
      for (const term of element.querySelectorAll(':scope > dt:not([hidden])'))
        lines.push(`- ${spacedText(term)}: ${term.nextElementSibling === null ? '' : spacedText(term.nextElementSibling)}`)
    }
    else if (tag === 'table') {
      for (const row of element.querySelectorAll('tr:not([hidden])'))
        lines.push(`- ${[...row.children].map(cell => spacedText(cell)).filter(Boolean).join(': ')}`)
    }
    else if (tag === 'ul') {
      for (const item of element.querySelectorAll(':scope > li:not([hidden])'))
        lines.push(`- ${spacedText(item)}`)
    }
    else if (tag === 'pre') {
      lines.push(fenced(element.textContent ?? ''))
    }
    else if (tag === 'details') {
      lines.push(`**${spacedText(element.querySelector('summary') ?? element)}**`, fenced(element.querySelector('pre')?.textContent ?? ''))
    }
    else if (kind.contains('problem')) {
      const level = kind.contains('error') ? 'Error' : 'Warning'
      const told = [...element.querySelectorAll(':scope > .pill')].map(pill => spacedText(pill)).filter(Boolean)

      lines.push(`**${level}**${told.length === 0 ? '' : `, ${told.join(', ')}`}`, fenced(element.querySelector('pre')?.textContent ?? ''))
    }
    else if (kind.contains('entry')) {
      const chips = [...element.querySelectorAll('.chips > *')].map(chip => spacedText(chip)).filter(Boolean)

      lines.push(`- ${spacedText(element.querySelector('.line')!)}`)

      if (chips.length > 0)
        lines.push(`  - ${chips.join(', ')}`)

      for (const issue of element.querySelectorAll('.issue'))
        lines.push(`  - ${issue.classList.contains('error') ? 'Error' : 'Warning'}: ${spacedText(issue)}`)

      for (const note of element.querySelectorAll('.body > .note'))
        lines.push(`  - ${spacedText(note)}`)
    }
    else if (kind.contains('vital')) {
      const rating = element.querySelector('.top .pill')
      const note = element.querySelector(':scope > .note')

      lines.push(`- ${spacedText(element.querySelector('.name')!)}: ${spacedText(element.querySelector('.num')!)}${rating === null ? '' : `, ${spacedText(rating)}`}`)

      if (note !== null)
        lines.push(`  - ${spacedText(note)}`)
    }
    else if (kind.contains('timing') || kind.contains('weight')) {
      // A grid of a name, a bar and a value per row, with a line of files under some.
      let row: string[] = []

      for (const cell of element.children) {
        if (cell.matches(UNCOPIED) || cell.classList.contains('bars') || spacedText(cell) === '') {
          continue
        }
        else if (cell.classList.contains('files')) {
          lines.push(`  - ${spacedText(cell)}`)
        }
        else {
          row.push(spacedText(cell))

          if (row.length === 2) {
            lines.push(`- ${row.join(': ')}`)
            row = []
          }
        }
      }
    }
    else if (element.children.length > 0 && ![...element.children].every(child => INLINE.has(child.localName))) {
      for (const child of element.children)
        block(child)
    }
    else {
      const text = spacedText(element)

      if (text !== '')
        lines.push(text)
    }
  }

  for (const child of panel.children)
    block(child)

  // Bullets run on, anything else stands apart.
  return lines.reduce((text, line, index) => index === 0 ? line : `${text}${BULLET.test(line) && BULLET.test(lines[index - 1]!) ? '\n' : '\n\n'}${line}`, '')
}
