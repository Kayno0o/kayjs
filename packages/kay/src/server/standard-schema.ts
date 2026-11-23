// Standard Schema v1 spec types (https://standardschema.dev) — works with Zod, Valibot, ArkType, TypeBox, etc.

export interface StandardSchemaIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) =>
      | { readonly value: Output, readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<StandardSchemaIssue> }
      | Promise<
        | { readonly value: Output, readonly issues?: undefined }
        | { readonly issues: ReadonlyArray<StandardSchemaIssue> }
      >
    readonly types?: { readonly input: Input, readonly output: Output } | undefined
  }
}

export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input']
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']

export interface ValidationFailure {
  ok: false
  issues: ReadonlyArray<StandardSchemaIssue>
  fieldErrors: Record<string, string>
}

export interface ValidationSuccess<T> {
  ok: true
  value: T
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

export async function validateSchema<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<InferOutput<S>>> {
  const res = await schema['~standard'].validate(input)
  if (res.issues && res.issues.length > 0) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of res.issues) {
      const key = issue.path && issue.path.length > 0
        ? issue.path.map(seg => (typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg))).join('.')
        : ''
      if (!(key in fieldErrors))
        fieldErrors[key] = issue.message
    }
    return { ok: false, issues: res.issues, fieldErrors }
  }
  return { ok: true, value: (res as { value: InferOutput<S> }).value }
}
