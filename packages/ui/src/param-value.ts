import { withQuery } from 'kay'

// The text of the page's query param `name`, read from the address the page is at: the request's on the server, the browser's after, in an island following each navigation, swap and Back or Forward step.
// A page rendered once at build time has no query to read, so it reads as left out.
export function paramText(name: string | undefined): string | undefined {
  return (name === undefined ? undefined : query()?.get(name)) ?? undefined
}

// Every text of the param `name`, `?tag=a&tag=b` giving two, or undefined when the address has none.
export function paramTexts(name: string | undefined): string[] | undefined {
  const found = name === undefined ? undefined : query()?.getAll(name)

  return found === undefined || found.length === 0 ? undefined : found
}

function query(): URLSearchParams | undefined {
  try {
    const href = withQuery({})
    const at = href.indexOf('?')

    return at === -1 ? undefined : new URLSearchParams(href.slice(at + 1))
  }
  catch {
    return undefined
  }
}

// The options a control holding several values in `param` shows, in the order of `options`: the ones the address names, else the ones `paramDefault` names, else undefined, which the control reads as none.
export function paramPicks<Choice extends string | number>(options: readonly { value: Choice }[], param: string | undefined, paramDefault: readonly Choice[] | undefined): Choice[] | undefined {
  if (param === undefined)
    return undefined

  const named = paramTexts(param)

  if (named === undefined)
    return paramDefault === undefined ? undefined : options.map(option => option.value).filter(value => paramDefault.includes(value))

  return options.map(option => option.value).filter(value => named.includes(String(value)))
}

// The option a control holding `param` shows: the one the address names, else the one `paramDefault` names, else none, which the control reads as its first or its empty option.
export function paramPick<Choice extends string | number | null>(options: readonly { value: Choice }[], param: string | undefined, paramDefault: string | number | undefined): Choice | undefined {
  if (param === undefined)
    return undefined

  const named = paramText(param)
  const found = named === undefined ? undefined : options.find(option => String(option.value) === named)

  return found ? found.value : options.find(option => paramDefault !== undefined && String(option.value) === String(paramDefault))?.value
}
