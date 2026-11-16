const TYPE_PARAMETER_NAME = /^\s*(?:(?:const|in|out)\s+)*([A-Z_$][\w$]*)/i
const CONSTRAINT = /\bextends\b([\s\S]*)$/
const ID = /\bid\b/

// `T extends Record<string, U>, const U = number` split at the commas outside any brackets, each parameter as written.
function split(parameters: string): string[] {
  const found: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index <= parameters.length; index++) {
    const char = parameters[index]

    if (char === '<' || char === '(' || char === '[' || char === '{')
      depth++
    else if ((char === '>' && parameters[index - 1] !== '=') || char === ')' || char === ']' || char === '}')
      depth--

    if (index < parameters.length && (char !== ',' || depth > 0))
      continue

    found.push(parameters.slice(start, index))
    start = index + 1
  }

  return found
}

// `T extends Record<string, U>, const U = number` names `T` and `U`: the first identifier of each parameter.
export function typeParameterNames(parameters: string): string[] {
  return split(parameters).flatMap((parameter) => {
    const name = TYPE_PARAMETER_NAME.exec(parameter)?.[1]

    return name === undefined ? [] : [name]
  })
}

// Whether the `for` of a generic component can be judged for rows with no `id`: not when a parameter has no constraint, or one that names an `id`, as the check cannot tell which parameter the rows are of and reads such a one as keyed. A parameter constrained to something with no `id` leaves the loop judged.
export function rowsJudged(parameters: string | undefined): boolean {
  return parameters === undefined || split(parameters).every((parameter) => {
    const constraint = CONSTRAINT.exec(parameter)?.[1]

    return constraint !== undefined && !ID.test(constraint)
  })
}
