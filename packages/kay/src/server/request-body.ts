// A request body read as string fields, for plugin routes that take a form or a JSON object.

/**
 * The string fields of a JSON object, urlencoded or multipart body, the last of a repeated name winning.
 * Files, numbers, arrays and nested objects are dropped, and any other content type gives no field.
 * The record has no prototype, so `__proto__` and `constructor` are plain fields. A malformed body throws.
 */
export async function readStringFields(request: Request): Promise<Record<string, string>> {
  const fields: Record<string, string> = Object.create(null)
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const raw: unknown = await request.json()
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      return fields
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string')
        fields[name] = value
    }
  }
  else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    for (const [name, value] of (await request.formData()).entries()) {
      if (typeof value === 'string')
        fields[name] = value
    }
  }
  return fields
}
