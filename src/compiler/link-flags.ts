import type { Attribute, Diagnostic, KayFile, Span } from './ast'
import type { Lint } from './lints'
import { editDistance } from './aria'
import { elementsIn } from './ast'

interface Renamed {
  name: string
  value: string
  // What a `false` value of the old name becomes, for a flag that was off by that word.
  off?: string
}

// The lint of this file, with the other lints in `LINTS`.
export const LINK_LINTS = {
  'unknown-link-flag': {
    level: 'deny',
    group: 'code',
    summary: 'A `data-` attribute one or two letters from a navigation flag of a link (`data-scroll`, `data-transition`, `data-prefetch`, `data-reload`), such as `data-prefech` or `data-no-scroll`: no type knows a `data-` name, so a misspelt flag would do nothing and the link would swap as before. Found on any element and on a component call. The fix, which is not safe as the name may be another attribute, writes the flag meant.',
    wrong: 'a(href="/tabs/a" data-scrol="keep") A',
    right: 'a(href="/tabs/a" data-scroll="keep") A',
  },
} satisfies Record<string, Lint>

// The attributes a link, or an element around links, takes to say how the swap follows it, named as the options of `navigate()` are: `scroll`, `transition`, `prefetch`, and `reload` for a full load.
const FLAGS = new Set(['data-scroll', 'data-transition', 'data-prefetch', 'data-reload'])
// The names before 1.105 and what each became: `data-keep-scroll` is `data-scroll="keep"`, `data-no-transition` is `data-transition="false"`, `data-no-prefetch` is `data-prefetch="false"`.
const OLD: Record<string, Renamed> = {
  'data-keep-scroll': { name: 'data-scroll', value: 'keep', off: 'top' },
  'data-no-transition': { name: 'data-transition', value: 'false' },
  'data-no-prefetch': { name: 'data-prefetch', value: 'false' },
}
const NEARBY = [...FLAGS, ...Object.keys(OLD)]

// The name an attribute is written with, none for a spread or a `{name}` shorthand.
function nameOf(attribute: Attribute): Span | undefined {
  return attribute.kind === 'spread' || (attribute.kind === 'expression' && attribute.shorthand !== undefined) ? undefined : attribute.name
}

// The flag a `data-` name is a misspelling of: the distance of what follows `data-` stays under a third of its length, at most 3, so `data-read` and `data-presence` are an app's own.
function nearest(name: string): string | undefined {
  const word = name.slice(5)
  const allowed = Math.min(3, Math.floor(word.length / 3))

  return NEARBY.find(flag => editDistance(word, flag.slice(5)) <= allowed)
}

// The navigation flags of links, on an element or on a component call that forwards them to its link: the names before 1.105 are `deprecated-link-flags` with a fix, and a `data-` name that is only a misspelling of one of the family is `unknown-link-flag`, as it would do nothing and no type knows a `data-` attribute.
export function linkFlags(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const element of elementsIn(file.template)) {
    for (const attribute of element.attributes) {
      const at = nameOf(attribute)

      if (at === undefined)
        continue

      const name = file.source.slice(at.start, at.end)
      const old = OLD[name]

      if (old !== undefined) {
        found.push(oldFlag(file.source, attribute, at, name, old))

        continue
      }

      const meant = name.startsWith('data-') && !FLAGS.has(name) ? nearest(name) : undefined

      if (meant === undefined)
        continue

      const to = OLD[meant]?.name ?? meant

      found.push({ ...at, code: 'unknown-link-flag', message: `\`${name}\` is no navigation flag of a link`, note: 'a link is followed with `data-scroll`, `data-transition`, `data-prefetch` and `data-reload`, and this name does nothing', help: `did you mean \`${to}\`?`, fixes: [{ title: `Write \`${to}\``, safe: false, edits: [{ ...at, text: to }] }], checkOnly: true })
    }
  }

  return found
}

function oldFlag(source: string, attribute: Attribute, at: Span, name: string, old: Renamed): Diagnostic {
  const base = { ...at, code: 'deprecated-link-flags', checkOnly: true, message: `\`${name}\` is \`${old.name}="${old.value}"\`, deprecated since 1.105`, help: `write \`${old.name}="${old.value}"\`, named as the option of \`navigate()\`` }

  if (attribute.kind === 'expression') {
    // The keep flag's value is read as before, so the rename is safe; the other two were set by being present, which no value of the new name says.
    return old.off === undefined ? base : { ...base, fixes: [{ title: `Write \`${old.name}\``, safe: true, edits: [{ ...at, text: old.name }] }] }
  }

  const written = old.off !== undefined && attribute.kind === 'static' && attribute.text === 'false' ? old.off : old.value
  const end = attribute.kind === 'static' ? attribute.value.end + ('"\''.includes(source[attribute.value.end] ?? '') ? 1 : 0) : at.end

  return { ...base, fixes: [{ title: `Write \`${old.name}="${written}"\``, safe: true, edits: [{ start: at.start, end, text: `${old.name}="${written}"` }] }] }
}
