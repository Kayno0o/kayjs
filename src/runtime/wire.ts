import { DevalueError } from 'devalue'

// Island props, action calls and the flash cookie go as devalue text: JSON that also carries Dates, Maps, Sets, bigints, URLs, RegExps, undefined and shared references.
export { parse as decodeValue, stringify as encodeValue, unflatten as unflattenValue } from 'devalue'

// What devalue refused and where, such as `Cannot stringify a function at .todo.format`; undefined for any other error.
export function unsendable(error: unknown): string | undefined {
  if (!(error instanceof DevalueError))
    return undefined

  return error.path === '' ? error.message : `${error.message} at ${error.path}`
}
