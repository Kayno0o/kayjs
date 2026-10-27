import { navigate } from 'kay'

// The change handler of a control that holds a query param: the app's own `onChange` first, which can refuse the change by answering false, then `navigate({ query })` setting the param and keeping the others.
// The default, an empty value and none leave the param out, so the page's plain address stays plain.
export function paramChange<Value extends string | number | null>(param: string | undefined, paramDefault: string | number | undefined, onChange: ((value: Value) => unknown) | undefined): ((value: Value) => unknown) | undefined {
  if (param === undefined)
    return onChange

  return async (value) => {
    if (onChange && await onChange(value) === false)
      return false

    return navigate({ query: { [param]: paramDefault !== undefined && String(value) === String(paramDefault) ? null : value } })
  }
}
