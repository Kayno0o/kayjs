// The attributes a form control owns, whichever element draws it: its state, its constraints, its handlers and its accessibility. They reach the input, and `inputProps` after them; everything else a component is given (`id`, `data-*`, `title`) is its root's.
const EVENT = /^on[A-Z]/
const OWNED = /^(?:aria-|ref$|accept$|autocomplete$|autofocus$|capture$|disabled$|enterkeyhint$|form$|inputmode$|invalid$|label$|list$|max$|maxlength$|min$|minlength$|multiple$|name$|pattern$|placeholder$|readonly$|required$|size$|spellcheck$|step$|tabindex$|value$)/i

// `props` split into what goes to the root and what goes to the input, getters kept so both stay live. `inputProps` is the app's own word for the input and has the last say.
export function controlProps(props: object, inputProps?: object): { root: Record<string, unknown>, field: Record<string, unknown> } {
  const root: PropertyDescriptorMap = {}
  const field: PropertyDescriptorMap = {}

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props))) {
    // A `part` names the parts of the component that draws the control, which each element sets for itself.
    if (key !== 'part')
      (EVENT.test(key) || OWNED.test(key) ? field : root)[key] = descriptor
  }

  if (inputProps)
    Object.assign(field, Object.getOwnPropertyDescriptors(inputProps))

  return { root: Object.defineProperties({}, root), field: Object.defineProperties({}, field) }
}
