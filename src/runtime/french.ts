const NBSP = '\u00A0'
const FRENCH = /^fr(?:-|$)/i
// The plain space before a mark, with the mark, and the plain space after an opening guillemet.
const BEFORE_MARK = / ([:;!?»])/g
const AFTER_OPENING = /« /g
// The elements whose text a page in French leaves as it is.
const LEFT_ALONE = 'code,pre,kbd,samp,script,style,textarea'

// Whether a page in this language gets French spaces: `fr` and `fr-CA`, not another language starting with the same letters.
export function isFrench(lang: string): boolean {
  return FRENCH.test(lang)
}

// The text with a plain space before `: ; ! ?` and `»`, and after `«`, made non-breaking; `guillemets` false leaves the text without a `«` out of the second search.
export function spaced(text: string, guillemets: boolean): string {
  const marked = text.replace(BEFORE_MARK, `${NBSP}$1`)

  return guillemets ? marked.replace(AFTER_OPENING, `«${NBSP}`) : marked
}

// What an island writes as text on a page in French, spaced as the server spaces the markup it rendered; an app without French pages is built without the calls to it.
// `parent` is where the text goes when it is known, and a text inside code, pre, kbd, samp, script, style or textarea is left as it is, as on the server.
export function frenchText(data: string, parent: Node | undefined): string {
  const written = spaced(data, true)

  if (written === data || !isFrench(document.documentElement.lang))
    return data

  return (parent as Element | undefined)?.closest?.(LEFT_ALONE) ? data : written
}
