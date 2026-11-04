import { effect, markInvalid, untrack } from 'kay'

// The utilities a Checkbox and a FormField draw with, which ContactForm's messages and kayjs-cms's field inputs take from here so a restyle of one reaches the copies.
export const CHECKBOX = {
  root: 'kui-checkbox inline-flex cursor-pointer items-center gap-2 has-[input:disabled]:opacity-50 has-[input[aria-busy=true]]:cursor-progress has-[input:disabled:not([aria-busy=true])]:cursor-not-allowed',
  input: 'm-0 size-4 shrink-0 cursor-[inherit] accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-invalid:accent-danger aria-invalid:outline aria-invalid:outline-offset-2 aria-invalid:outline-danger aria-invalid:focus-visible:outline-2',
  label: 'text-sm text-foreground',
  hint: 'text-xs text-muted',
}

export const FIELD_MESSAGE = {
  hint: 'text-xs text-muted',
  issues: 'flex flex-col',
  issue: 'text-xs text-danger',
}

// The label type a Slider, a ColorInput and a FormField write their label in, and a Segmented or a ChipGroup given `showLabel` its own.
export const LABEL_TEXT = 'text-xs [font-weight:var(--font-weight-normal)] tracking-label text-muted [font-family:var(--font-label,inherit)] [text-transform:var(--label-case)]'

export type FieldSize = 'sm' | 'md' | 'lg'

// The look a TextInput, a Textarea and a Select draw their box with, less its padding and type, which FIELD_BOX and FIELD_SELECT_BOX add; `aria-invalid` turns the line and the focus ring to the danger colour. 'kui-field-input' is the field's name for an app's CSS and the skins, and the hook of the rule that gives the raw controls of a FormField this look. The focus outline doubles the accent border, so focus reads by more than a colour change.
export const FIELD_LOOK = 'kui-field-input rounded-md bg-surface text-foreground outline-none [font-family:inherit] [border:var(--border-width)_solid_var(--color-input)] placeholder:text-[var(--color-muted)] focus:border-ring focus:[outline:1px_solid_var(--color-ring)] focus:[box-shadow:none] disabled:cursor-default disabled:opacity-50 aria-invalid:border-danger aria-invalid:focus:border-danger aria-invalid:focus:[outline-color:var(--color-danger)]'

// What a `size` of `sm` or `lg` changes on a box: the padding, the type and the three variables theme.css builds `--_field-height` from, which a select and a button beside it read. Medium is the base. The numbers are the ones of the `.kui-field-input` size rules in theme.css, for the controls drawn by that class alone, a test holds them together. Written out, as Tailwind reads class names from the source.
export const FIELD_SIZES = 'data-[size=sm]:px-[calc(var(--spacing)*1.75*var(--density))] data-[size=sm]:py-[calc(var(--spacing)*0.5*var(--density))] data-[size=sm]:text-xs data-[size=sm]:[--_field-pad:calc(var(--spacing)*0.5*var(--density))] data-[size=sm]:[--_field-text:var(--text-xs)] data-[size=sm]:[--_field-line:var(--text-xs--line-height)] data-[size=lg]:px-[calc(var(--spacing)*3*var(--density))] data-[size=lg]:py-[calc(var(--spacing)*1.5*var(--density))] data-[size=lg]:text-base data-[size=lg]:[--_field-pad:calc(var(--spacing)*1.5*var(--density))] data-[size=lg]:[--_field-text:var(--text-base)] data-[size=lg]:[--_field-line:var(--text-base--line-height)]'

// The padding and type of a text box and a textarea at the medium size.
export const FIELD_BOX = `px-[calc(var(--spacing)*2.25*var(--density))] py-[calc(var(--spacing)*var(--density))] text-sm ${FIELD_SIZES}`

// A select's left padding only: the right is the rule's in theme.css, as a skin's chevron gives it more room, which a utility here would take back.
export const FIELD_SELECT_BOX = `pl-[calc(var(--spacing)*2.25*var(--density))] py-[calc(var(--spacing)*var(--density))] text-sm data-[size=sm]:pl-[calc(var(--spacing)*1.75*var(--density))] data-[size=sm]:py-[calc(var(--spacing)*0.5*var(--density))] data-[size=sm]:text-xs data-[size=sm]:[--_field-pad:calc(var(--spacing)*0.5*var(--density))] data-[size=sm]:[--_field-text:var(--text-xs)] data-[size=sm]:[--_field-line:var(--text-xs--line-height)] data-[size=lg]:pl-[calc(var(--spacing)*3*var(--density))] data-[size=lg]:py-[calc(var(--spacing)*1.5*var(--density))] data-[size=lg]:text-base data-[size=lg]:[--_field-pad:calc(var(--spacing)*1.5*var(--density))] data-[size=lg]:[--_field-text:var(--text-base)] data-[size=lg]:[--_field-line:var(--text-base--line-height)]`

// A refused slider turns its thumb to the danger colour, and `sm` and `lg` resize the thumb.
export const SLIDER_STATE = 'aria-invalid:[&::-webkit-slider-thumb]:bg-danger aria-invalid:[&::-moz-range-thumb]:bg-danger data-[size=sm]:h-3 data-[size=sm]:[&::-webkit-slider-thumb]:-mt-1 data-[size=sm]:[&::-webkit-slider-thumb]:size-3 data-[size=sm]:[&::-moz-range-thumb]:size-3 data-[size=lg]:h-5 data-[size=lg]:[&::-webkit-slider-thumb]:-mt-2 data-[size=lg]:[&::-webkit-slider-thumb]:size-5 data-[size=lg]:[&::-moz-range-thumb]:size-5'

// The `data-size` a control writes on its box: nothing for the medium size.
export function fieldSize(size: FieldSize | undefined): FieldSize | undefined {
  return size === 'md' ? undefined : size
}

// The `aria-invalid` a control draws, read once: `keepInvalid` holds it in the browser after.
export function fieldInvalid(invalid: () => boolean | undefined): 'true' | undefined {
  return untrack(invalid) === true ? 'true' : undefined
}

// Holds `aria-invalid` on a box while `invalid` is true through the mark a FormField message and a refused action share, so `invalid` going false leaves the box invalid while another source still refuses it. The attribute drawn for the first value is taken off first, so the mark is this control's.
export function keepInvalid(box: Element, invalid: () => boolean | undefined): void {
  if (untrack(invalid) === true)
    box.removeAttribute('aria-invalid')

  effect(() => markInvalid(box, keepInvalid, invalid() === true))
}

// A refused group of radios draws each radio in the danger colour, whether the group or the radio itself carries `aria-invalid`; `radios` names the group they read.
export const RADIO_INVALID = 'aria-invalid:accent-danger aria-invalid:outline aria-invalid:outline-offset-2 aria-invalid:outline-danger group-aria-invalid/radios:accent-danger group-aria-invalid/radios:outline group-aria-invalid/radios:outline-offset-2 group-aria-invalid/radios:outline-danger'

// A refused Segmented, ChipGroup or FileDrop turns its keyline, which they read from `--_control-line`, to the danger colour, whether the group carries `aria-invalid` or a FormField marked a field in it.
export const GROUP_INVALID = 'aria-invalid:[--_control-line:var(--color-danger)] has-[input[aria-invalid=true]]:[--_control-line:var(--color-danger)]'
