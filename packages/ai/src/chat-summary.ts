const LIMIT = 80

function written(input: unknown): string {
  if (typeof input === 'string')
    return input

  if (typeof input === 'object' && !Array.isArray(input))
    return Object.entries(input!).map(([key, value]) => `${key}: ${JSON.stringify(value) ?? String(value)}`).join(', ')

  return JSON.stringify(input) ?? ''
}

// One line of a tool call's input for the approval row: `query: "refund policy", limit: 3`, cut at 80 characters. Not JSON, which a visitor does not read.
export function inputSummary(input: unknown): string {
  if (input === null || input === undefined)
    return ''

  const text = written(input)

  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1).trimEnd()}…` : text
}
