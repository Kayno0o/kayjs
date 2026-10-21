// The classes of a variant value: a string for the root, or one string per part.
type VariantClasses = string | Readonly<Record<string, string>>

type VariantTable = Readonly<Record<string, Readonly<Record<string, VariantClasses>>>>

// The names of a variant's values, a numeric key such as `2` included.
type ValueNames<Values> = `${keyof Values & (string | number)}`

// The values a variant takes as a prop: a variant with only `true` and `false` entries is a boolean, and a numeric key takes the number as well as its text.
type VariantValue<Values> = [ValueNames<Values>] extends [never] ? never : [ValueNames<Values>] extends ['true' | 'false'] ? boolean : ValueNames<Values> | NumberOf<ValueNames<Values>>

// The number a name reads as, for each name of a union: `'1' | 'a'` gives `1`.
type NumberOf<Name> = Name extends `${infer Number extends number}` ? Number : never

type VariantValues<Variants extends VariantTable> = { [Name in keyof Variants]?: VariantValue<Variants[Name]> | undefined }

// The variant props a recipe adds to a component's props, inferred from the recipe so the component declares them once.
export type RecipeProps<Recipe> = Recipe extends (values?: infer Values, part?: string) => string ? NonNullable<Values> : never

export interface Recipe<Variants extends VariantTable> {
  // The classes of a part, `root` unless named: its base, then the variant of each value given, in the order the variants are declared.
  (values?: VariantValues<Variants>, part?: string): string
  readonly variants: readonly (keyof Variants & string)[]
}

export interface RecipeConfig<Variants extends VariantTable> {
  // The base classes: a string for the root, or one string per part.
  parts?: string | Readonly<Record<string, string>>
  variants?: Variants
  defaults?: VariantValues<NoInfer<Variants>>
}

// A component's classes by part and variant, whose variants become props of the component: the compiler reads `const card = recipe({ ... })` and types the props from it, with no declaration beside it.
export function recipe<const Variants extends VariantTable = Record<never, never>>(config: RecipeConfig<Variants>): Recipe<Variants> {
  const base = typeof config.parts === 'string' ? { root: config.parts } : config.parts ?? {}
  const variants = Object.entries(config.variants ?? {})
  const defaults: Record<string, unknown> = config.defaults ?? {}

  return Object.assign((values: Record<string, unknown> = {}, part = 'root') => {
    const classes = [Object.hasOwn(base, part) ? base[part] : undefined]

    for (const [name, options] of variants) {
      const given = values[name] ?? defaults[name]
      const key = typeof given === 'string' || typeof given === 'number' || typeof given === 'boolean' ? String(given) : undefined
      const entry = key !== undefined && Object.hasOwn(options, key) ? options[key] : undefined

      classes.push(partClasses(entry, part))
    }

    return classes.filter(text => text !== undefined && text !== '').join(' ')
  }, { variants: variants.map(([name]) => name) })
}

// What a variant value gives a part: a string is the root's, an object holds an entry per part.
function partClasses(entry: VariantClasses | undefined, part: string): string | undefined {
  if (typeof entry === 'string')
    return part === 'root' ? entry : undefined

  return entry !== undefined && Object.hasOwn(entry, part) ? entry[part] : undefined
}
