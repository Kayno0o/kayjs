// The names the compiler writes into a component's module, which the passes and the editor all read.

// The props object every component function takes.
export const PROPS = '__props'
// The value an updater gets, as `count += 1` writes `count.set((KayCurrent) => KayCurrent + 1)`.
export const CURRENT = 'KayCurrent'
// What type checking reads a template's signal through, `(void count, __values.count)`, a property TypeScript narrows where it narrows no call.
export const VALUES = '__values'
// What type checking wraps a name kay sees no signal made in, assigned, so the type checker asserts it holds one: `KayWritable(theme).set('dark')`.
export const WRITABLE = 'KayWritable('
// What type checking reads a defaulted prop through, `KayDefault(__props.size, __default_0)`: the same value as the `!== undefined` ternary the output modes write, without a ternary for a lint rule to judge in the shadow.
export const DEFAULTED = 'KayDefault('
// What type checking wraps a signal the template hands on whole, a function's argument or a component's prop, so the types report one handed to a parameter that takes anything: `describe(KayHanded(count))`.
export const HANDED = 'KayHanded('
// What an assignment to a property, an element or a `let` that may hold a signal becomes, the signal being told from anything else when it runs: `KayWriteTo(box, "count", 1)`, `c = KayWriteBack(c, 1)`. Type checking imports the same ones, whose signatures type the write by what the target holds.
export const WRITE_HELPERS = { to: 'KayWriteTo', update: 'KayUpdateTo', back: 'KayWriteBack', updateBack: 'KayUpdateBack' } as const
// What type checking passes a signal write after its value, never called: TypeScript judges the plain assignment in it, so a readonly key is an error as it is in plain code.
export const PROBE = '(KayTarget, KayKey) => { KayTarget[KayKey] = undefined as never }'
// A `case` block's subject, read once for every `when`.
export const SUBJECT = 'KaySubject'
// The server fence's function, which hands its data to the template.
export const LOAD = 'load'
// The component function's name in the analysis pass, which no read in the source can resolve to: the real one is chosen once the reads are known.
export const SELF = 'KaySelf'

const DEFAULT_PREFIX = '__default_'

// A prop default's getter, by the prop's index in the destructuring.
export function defaultName(index: number): string {
  return `${DEFAULT_PREFIX}${index}`
}

// What the editor leaves out of completions: the names above a completion can reach, and what the generated code imports or declares.
export const GENERATED_NAME = new RegExp(`^(?:${[PROPS, VALUES, CURRENT, 'kayEvent', 'kayMatched', 'kayAwaited', 'kayEach'].join('|')}|${DEFAULT_PREFIX}\\d+|Kay(?:Default|LoopFor|StaticFor|Show|Omit|ComponentClass|PartClass|PartsClass|PartOf|Dynamic|TemplateHelpers|Island|IslandBrand|HydrateWhen|Href|Html|Field|FormError|Prop|PlainProp|FunctionProp|Children|Row|Truthy|Unmatched|Radio|Writable|WriteTo|UpdateTo|WriteBack|UpdateBack|Bound|Bindable|Handed|PageContext|PrerenderedContext|PageSettings|QueryOf|PageData|JSX|FormAction|RegisterActions|ActionStub|ReviveActions|UseHead|Await|Awaited|Try))$`)
