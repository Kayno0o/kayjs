import type { RecipeConfig, VariantTable } from './recipe'

// What `src/ui.ts` sets for one component: the shape of a recipe without its defaults, which the component's own recipe keeps.
export type UiEntry = Omit<RecipeConfig<VariantTable>, 'defaults'>

// Augmented by the `.kay/types/kay-ui.d.ts` that `kay check` writes with each component `src/ui.ts` can restyle, by name and by specifier: its part names and the values of its variants.
export interface UiComponents {}

interface UiShape {
  parts: string
  variants: Record<string, string>
}

type PartClasses<Parts extends string> = Readonly<Partial<Record<Parts, string>>>

// The values of one variant: the component's own are completed, and any other is added to the variant.
type ValueClasses<Values extends string, Parts extends string> = Readonly<Partial<Record<Values, string | PartClasses<Parts>>>> & Readonly<Record<string, string | PartClasses<Parts> | undefined>>

// One component's entry: its parts, and the values of its variants, each restyling the parts it names. A variant or value the component lacks is added to it.
interface UiEntryOf<Shape extends UiShape> {
  readonly parts?: string | PartClasses<Shape['parts']>
  readonly variants?: { readonly [Variant in keyof Shape['variants']]?: ValueClasses<Shape['variants'][Variant], Shape['parts']> } & Readonly<Record<string, ValueClasses<never, Shape['parts']> | undefined>>
}

// The components `src/ui.ts` restyles, by the name a template calls each or by the specifier `src/ui.ts` would import it from. Until `kay check` has written the components, any key.
export type UiConfig = [keyof UiComponents] extends [never] ? Readonly<Record<string, UiEntry>> : { readonly [Key in keyof UiComponents]?: UiEntryOf<UiComponents[Key]> }

// The default export of `src/ui.ts`, read by the compiler as it is written, so it holds string literals alone.
export function defineUi(config: UiConfig): UiConfig {
  return config
}
