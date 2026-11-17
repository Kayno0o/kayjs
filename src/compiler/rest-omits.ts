import type { TemplateFacts } from './ast'
import type { PropsDeclaration } from './script'

// The keys `omit` takes out of the props to make the rest object: the declared props that can arrive (all of them, or the ones `written` names), then what a component that merges parts owns (`class`, `parts`, its recipe's variants and the app's).
export function restOmits(props: PropsDeclaration, written: ReadonlySet<string> | undefined, facts: TemplateFacts): string[] {
  const owned = facts.parts?.merges === true
  const declared = props.bindings.filter(binding => written?.has(binding.key) ?? true)

  return [
    ...declared.map(binding => JSON.stringify(binding.key)),
    ...owned ? ['"class"', '"parts"'] : [],
    ...owned && facts.recipe !== undefined ? [`...${facts.recipe}.variants`] : [],
    ...owned ? Object.keys(facts.ui?.variants ?? {}).map(name => JSON.stringify(name)) : [],
  ]
}
