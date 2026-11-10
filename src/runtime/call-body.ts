// A value as a form field or a query param carries it: a Date as its ISO text, an object as JSON.
export function fieldText(value: unknown): string {
  if (value instanceof Date)
    return value.toISOString()

  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

// A body carrying files goes as a form, its other fields as text, which Elysia reads against the route's schema; anything else goes as JSON.
export function callBody(body: unknown): { body?: BodyInit | undefined, headers?: Record<string, string> } {
  if (body === undefined || body instanceof FormData)
    return { body }

  const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.entries(body) : []

  if (!fields.some(([, value]) => value instanceof Blob || (Array.isArray(value) && value.some(item => item instanceof Blob))))
    return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }

  const form = new FormData()

  for (const [name, value] of fields) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value]) {
      if (item !== undefined && item !== null)
        form.append(name, item instanceof Blob ? item : fieldText(item))
    }
  }

  return { body: form }
}
