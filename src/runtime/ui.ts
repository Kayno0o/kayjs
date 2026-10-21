import type { RecipeConfig, VariantTable } from './recipe'

// What `src/ui.ts` sets for one component: the shape of a recipe without its defaults, which the component's own recipe keeps.
export type UiEntry = Omit<RecipeConfig<VariantTable>, 'defaults'>

// The components `src/ui.ts` restyles, by the specifier `src/ui.ts` would import each from.
export type UiConfig = Readonly<Record<string, UiEntry>>

// The default export of `src/ui.ts`, read by the compiler as it is written, so it holds string literals alone.
export function defineUi<const Config extends UiConfig>(config: Config): Config {
  return config
}
