// The shape every Standard Schema validator (Zod 4.2+, ArkType 2.1.28+, Valibot) has, https://standardschema.dev: written here so kay needs no dependency to accept one.
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input, readonly output: Output } | undefined
    // The JSON Schema extension: what a form's constraints, OpenAPI and MCP are read from.
    readonly jsonSchema?: { readonly input: (options: { target: string }) => Record<string, unknown> } | undefined
  }
}

export type StandardResult<Output> = { readonly value: Output, readonly issues?: undefined } | { readonly issues: readonly { readonly message: string, readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined }[] }

export type StandardOutput<Type> = Type extends { '~standard': { types?: infer Types } } ? NonNullable<Types> extends { output: infer Output } ? Output : unknown : never

export function isStandardSchema(value: unknown): value is StandardSchema {
  return typeof value === 'object' && value !== null && '~standard' in value && typeof (value as StandardSchema)['~standard'].validate === 'function'
}

// The JSON Schema a Standard Schema validator describes its input with, as draft 2020-12; undefined for one without the extension, which validates but gives a form no constraints, nor OpenAPI and MCP a description.
export function jsonSchemaOf(schema: object): Record<string, unknown> | undefined {
  if (!isStandardSchema(schema))
    return schema as Record<string, unknown>

  try {
    return schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' })
  }
  catch {
    return undefined
  }
}
