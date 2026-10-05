// A range's two bounds, each open when null.
export type RangeValue = [number | null, number | null]

function parse(text: string): number | null {
  return text.trim() === '' || !Number.isFinite(Number(text)) ? null : Number(text)
}

// The bounds as typed, an empty box read as open and a reversed pair put back in order.
export function rangeFrom(low: string, high: string): RangeValue {
  const from = parse(low)
  const to = parse(high)

  return from !== null && to !== null && from > to ? [to, from] : [from, to]
}
