// What Zod, ArkType and Valibot hand kay: a `~standard` property and nothing else of theirs is read, so these stand in for them with no dependency.
const ISSUE = { message: 'age is a whole number', path: ['age'] }

function validate(value: unknown) {
  const input = value as { age?: unknown } | null

  return typeof input === 'object' && input !== null && Number.isInteger(input.age) ? { value: { age: input.age as number } } : { issues: [ISSUE] }
}

// With the JSON Schema extension, as Zod 4 and ArkType give.
export const described = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate,
    types: undefined as unknown as { input: { age: number }, output: { age: number } },
    jsonSchema: { input: () => ({ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] }) },
  },
}

// Without it.
export const plain = { '~standard': { version: 1 as const, vendor: 'test', validate, types: undefined as unknown as { input: { age: number }, output: { age: number } } } }
