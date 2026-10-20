import { describe, expect, it } from 'bun:test'
import { TAILWIND_CLASS_REGEX, templateFiles } from '../src/templates'

// How Tailwind IntelliSense reads a classRegex: a string's first group is a class list, a pair's container group is searched for the inner regex.
function classesIn(text: string): string[] {
  return TAILWIND_CLASS_REGEX.flatMap((entry) => {
    if (typeof entry === 'string')
      return [...text.matchAll(new RegExp(entry, 'gi'))].flatMap(match => match[1]!.split(/\s+/).filter(Boolean))

    const [container, inner] = entry

    return [...text.matchAll(new RegExp(container, 'gi'))].flatMap(match => [...match[1]!.matchAll(new RegExp(inner, 'gi'))].map(found => found[1]!))
  })
}

describe('the starter app\'s Tailwind IntelliSense setting', () => {
  it('reads the classes of the shorthand', () => {
    expect(classesIn('div.flex.items-center.gap-4\n')).toEqual(['flex', 'items-center', 'gap-4'])
    expect(classesIn('.card.p-4\n')).toEqual(['card', 'p-4'])
    expect(classesIn('    a.btn#go(href="/x") Go\n')).toEqual(['btn'])
    expect(classesIn('  Card.mt-2.md:flex(title="t")\n')).toEqual(['mt-2', 'md:flex'])
    expect(classesIn('p Some #[b.font-bold bold] text\n')).toEqual(['font-bold'])
  })

  it('reads the classes after an id, with or without a tag', () => {
    expect(classesIn('input#x.peer.sr-only(type="checkbox")\n')).toEqual(['peer', 'sr-only'])
    expect(classesIn('  #main.container.mx-auto\n')).toEqual(['container', 'mx-auto'])
    expect(classesIn('p See #[a#top.underline.font-bold link] here\n')).toEqual(['underline', 'font-bold'])
    expect(classesIn('div#a\n')).toEqual([])
  })

  it('keeps a decimal, a bracket group and a variable group whole', () => {
    expect(classesIn('div.p-1.5.w-1/2.hover:bg-red-500\n')).toEqual(['p-1.5', 'w-1/2', 'hover:bg-red-500'])
    expect(classesIn('div.w-[calc(100%-2rem)].[&>svg]:size-4.bg-(--brand)/50\n')).toEqual(['w-[calc(100%-2rem)]', '[&>svg]:size-4', 'bg-(--brand)/50'])
    expect(classesIn('div.col-2.2xl:flex\n')).toEqual(['col-2', '2xl:flex'])
  })

  it('reads every element of a template, one line each', () => {
    expect(classesIn('main.grid\n  section.p-2.rounded\n    p.text-sm Hello\n')).toEqual(['grid', 'p-2', 'rounded', 'text-sm'])
  })

  it('reads a class attribute, over lines too', () => {
    expect(classesIn('div(class="flex p-4")\n')).toEqual(['flex', 'p-4'])
    expect(classesIn('div(\n  class="\n    flex p-4\n    gap-2\n  "\n)\n')).toEqual(['flex', 'p-4', 'gap-2'])
  })

  it('leaves text, a tag alone and an expression out', () => {
    expect(classesIn('p Read example.com now\n')).toEqual([])
    expect(classesIn('| a.b.c\n')).toEqual([])
    expect(classesIn('div\nspan {user.name}\n')).toEqual([])
  })

  it('is written to the settings of an app with Tailwind, beside the ESLint one', () => {
    const settings = (...features: Parameters<typeof templateFiles>[0] extends ReadonlySet<infer F> ? F[] : never) => templateFiles(new Set(features))['.vscode/settings.json']

    expect(JSON.parse(settings('tailwind')!)).toEqual({ 'tailwindCSS.includeLanguages': { kay: 'html' }, 'tailwindCSS.experimental.classRegex': TAILWIND_CLASS_REGEX })
    expect(Object.keys(JSON.parse(settings('tailwind', 'eslint')!))).toEqual(['eslint.validate', 'tailwindCSS.includeLanguages', 'tailwindCSS.experimental.classRegex'])
    expect(JSON.parse(settings('eslint')!)).toEqual({ 'eslint.validate': ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'kay'] })
    expect(settings()).toBeUndefined()
  })
})
