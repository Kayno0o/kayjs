// The ramp a contribution cell fills along: nothing at 0, a visible floor just above it, full at 1.
// `color-mix` takes any CSS colour, so a theme variable shades as well as a stored hex.
export function shade(color: string, value: number): string | undefined {
  if (value <= 0)
    return undefined

  return `color-mix(in srgb, ${color} ${Math.round((0.25 + 0.75 * Math.min(value, 1)) * 100)}%, transparent)`
}
