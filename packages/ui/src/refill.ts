// The option a refused post chose among `options`, which post their value as text, `fallback` when it chose none of them or no post was refused.
export function sentOption<Choice extends string | number | null, Held>(sent: string | undefined, options: readonly { value: Choice }[], fallback: Held): Choice | Held {
  if (sent === undefined)
    return fallback

  const chosen = options.find(option => String(option.value ?? '') === sent)

  return chosen === undefined ? fallback : chosen.value
}
