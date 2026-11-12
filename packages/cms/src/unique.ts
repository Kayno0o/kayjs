import type { Issue, JsonSchema } from './kay/contract'

// The top-level fields declared `unique`, those of an `Intersect`'s members as well.
function uniqueKeys(schema: JsonSchema): string[] {
  const { properties = {}, allOf = [] } = schema as { properties?: Record<string, { 'x-kay-unique'?: boolean }>, allOf?: JsonSchema[] }

  return [...new Set([...Object.keys(properties).filter(key => properties[key]!['x-kay-unique'] === true), ...allOf.flatMap(uniqueKeys)])]
}

// The refusal with each issue's message led by its field, as the toast shows the messages alone.
export function namingFields<Outcome extends { issues: Issue[] }>(outcome: Outcome): Outcome {
  return { ...outcome, issues: outcome.issues.map(issue => issue.path === '' ? issue : { ...issue, message: `${issue.path}: ${issue.message}` }) }
}

// A copy of an entry with the `unique` values another entry holds already made free, as a copy kept as they are would be refused: text gets a suffix like the slug does, any other value is left for the editor to give.
export function withFreeUniques(schema: JsonSchema, data: Record<string, unknown>, siblings: { data?: Record<string, unknown> | undefined }[], suffixed: (value: string, taken: Set<string>) => string): Record<string, unknown> {
  const copy = { ...data }

  for (const key of uniqueKeys(schema)) {
    const value = copy[key]

    if (typeof value === 'string')
      copy[key] = suffixed(value, new Set(siblings.map(entry => String(entry.data?.[key]))))
    else if (value !== undefined && value !== null)
      delete copy[key]
  }

  return copy
}
