// The track and the thumb of both engines, drawn from the field and accent tokens, which Slider and AudioPlayer share on their range input.
// The track is filled up to the thumb: Chromium reads the share from `--range-fill` (see `rangeFill`), Firefox draws `::-moz-range-progress`; an invalid range fills in the danger colour and a disabled one in the muted.
export const rangeTrack = 'h-4 w-full cursor-pointer appearance-none bg-transparent [--range-tint:var(--color-accent)] aria-invalid:[--range-tint:var(--color-danger)] disabled:[--range-tint:var(--color-muted)] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-input [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--range-tint)_var(--range-fill,0%),transparent_var(--range-fill,0%))] [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-input [&::-moz-range-progress]:h-1 [&::-moz-range-progress]:bg-[var(--range-tint)] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-sm [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50'

const TRAILING = /;?\s*$/

// The `style` of a range input: the share of its track up to the thumb, `0%` to `100%`, after the `style` the app gave it.
export function rangeFill(value: number, min: number, max: number, own?: unknown): string {
  const share = max > min ? Math.min(100, Math.max(0, (value - min) / (max - min) * 100)) : 0

  return `${typeof own === 'string' && own ? `${own.replace(TRAILING, '')};` : ''}--range-fill:${share}%`
}
