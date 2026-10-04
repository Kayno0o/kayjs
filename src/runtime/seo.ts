// Schema.org structured data: `@type` names what it describes, every other property is the vocabulary's own.
export interface JsonLd {
  '@context'?: string
  '@type': string | string[]
  '@id'?: string
  [property: string]: unknown
}

const SCHEMA_ORG = 'https://schema.org'
const LESS_THAN = /</g

// The text of a `script(type="application/ld+json")`, in the schema.org context unless it names its own; several things go in one `@graph`. No `<` survives, so a value cannot end the script.
export function jsonLd(data: JsonLd | JsonLd[]): string {
  const document = Array.isArray(data) ? { '@context': SCHEMA_ORG, '@graph': data } : { '@context': SCHEMA_ORG, ...data }

  return JSON.stringify(document).replace(LESS_THAN, '\\u003c')
}
