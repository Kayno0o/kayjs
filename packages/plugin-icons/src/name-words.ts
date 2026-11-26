const SPLIT = /[^a-z0-9]+/
const DIGITS = /^\d+$/

// The words of an icon name or a query, `arrow-left-2` giving `arrow` and `left`, and `circle-x` giving `circle` and `x`.
export function nameWords(text: string): string[] {
  return text.toLowerCase().split(SPLIT).filter(word => word !== '' && !DIGITS.test(word))
}

// How many parts a name has, numbers included, so `user-2` and `user-x` weigh as variants of `user`.
export function nameParts(name: string): number {
  return name.toLowerCase().split(SPLIT).filter(part => part !== '').length
}

const KEEPS_S = /(?:ss|us|is)$/
const DOUBLED = /([^aeiouylsz])\1$/

// What the forms of a word share, so `saves`, `saved` and `saving` give `sav`, `users` gives `user` and `boxes` gives `box`; a stem keeps 3 letters at least, and a doubled letter goes only past 3, as `running` gives `run` but `added` gives `add`.
export function stem(word: string): string {
  const cut = (form: string, letters: number) => form.length - letters >= 3 ? form.slice(0, -letters) : form
  let base = word

  if (base.endsWith('ies'))
    base = `${cut(base, 3)}y`
  else if (base.endsWith('s') && !KEEPS_S.test(base))
    base = cut(base, 1)

  const ending = base.endsWith('ing') ? 3 : base.endsWith('ed') && !base.endsWith('eed') ? 2 : 0

  if (ending > 0)
    base = cut(base, ending)
  if (ending > 0 && base.length > 3)
    base = base.replace(DOUBLED, '$1')

  return base.endsWith('e') ? cut(base, 1) : base
}

// Each stem to the shortest of the words holding it, which is most often the plain form.
export function byStem(words: Iterable<string>): Map<string, string> {
  const forms = new Map<string, string>()

  for (const word of words) {
    const key = stem(word)
    const known = forms.get(key)

    if (known === undefined || word.length < known.length)
      forms.set(key, word)
  }

  return forms
}
