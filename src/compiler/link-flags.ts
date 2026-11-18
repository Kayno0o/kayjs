import type { Attribute, Diagnostic, KayFile, Span } from './ast'
import type { Lint } from './lints'
import { editDistance } from './aria'
import { elementsIn } from './ast'

// The lint of this file, with the other lints in `LINTS`.
export const LINK_LINTS = {
  'unknown-link-flag': {
    level: 'deny',
    group: 'code',
    summary: 'A `data-` attribute one letter from a navigation flag of a link (`data-scroll`, `data-transition`, `data-prefetch`, `data-reload`), such as `data-prefech` or `data-scrol`: no type knows a `data-` name, so a misspelt flag would do nothing and the link would swap as before. Found on any element and on a component call. The fix, which is not safe as the name may be another attribute, writes the flag meant.',
    wrong: 'a(href="/tabs/a" data-scrol="keep") A',
    right: 'a(href="/tabs/a" data-scroll="keep") A',
  },
} satisfies Record<string, Lint>

// The attributes a link, or an element around links, takes to say how the swap follows it, named as the options of `navigate()` are: `scroll`, `transition`, `prefetch`, and `reload` for a full load.
const FLAGS = new Set(['data-scroll', 'data-transition', 'data-prefetch', 'data-reload'])

// The name an attribute is written with, none for a spread or a `{name}` shorthand.
function nameOf(attribute: Attribute): Span | undefined {
  return attribute.kind === 'spread' || (attribute.kind === 'expression' && attribute.shorthand !== undefined) ? undefined : attribute.name
}

// The flag a `data-` name is a misspelling of: one letter off, two adjacent letters swapped, or a flag cut short. A name that goes on after a flag (`data-scrolled`, `data-reloading`, `data-scroll-x`) is an app's own, so is a name far from every flag.
function nearest(name: string): string | undefined {
  const word = name.slice(5)

  return [...FLAGS].find((flag) => {
    const meant = flag.slice(5)

    return !word.startsWith(meant) && (editDistance(word, meant) <= 1 || swapped(word, meant))
  })
}

// Two adjacent letters written in the other order, `realod` for `reload`.
function swapped(a: string, b: string): boolean {
  const at = [...a].findIndex((char, index) => char !== b[index])

  return a.length === b.length && at >= 0 && a[at] === b[at + 1] && a[at + 1] === b[at] && a.slice(at + 2) === b.slice(at + 2)
}

// The navigation flags of links, on an element or on a component call that forwards them to its link: a `data-` name that is only a misspelling of one of the family is `unknown-link-flag`, as it would do nothing and no type knows a `data-` attribute.
export function linkFlags(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const element of elementsIn(file.template)) {
    for (const attribute of element.attributes) {
      const at = nameOf(attribute)

      if (at === undefined)
        continue

      const name = file.source.slice(at.start, at.end)
      const meant = name.startsWith('data-') && !FLAGS.has(name) ? nearest(name) : undefined

      if (meant === undefined)
        continue

      const fixes = [{ title: `Write \`${meant}\``, safe: false, edits: [{ ...at, text: meant }] }]

      found.push({ ...at, code: 'unknown-link-flag', message: `\`${name}\` is no navigation flag of a link`, note: 'a link is followed with `data-scroll`, `data-transition`, `data-prefetch` and `data-reload`, and this name does nothing', help: `did you mean \`${meant}\`?`, fixes, checkOnly: true })
    }
  }

  return found
}
