/** @jsxImportSource @kayjs/kay */
// Zero-JS static & native-platform primitives (`0 KB` client JS!) split from static.tsx so islands using only Field/Button/Notice don't bundle unused templates.

import type { KayChild } from '@kayjs/kay'
import type { ButtonVariant, SpaceValue, Tone, TrackValue } from './static'

const SPACE_TOKENS = new Set<string>(['none', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'])
const TRACK_TOKENS = new Set<string>(['xs', 'sm', 'md', 'lg', 'xl'])
const isSpaceToken = (v: string | undefined): boolean => v !== undefined && SPACE_TOKENS.has(v)
const isTrackToken = (v: string | undefined): boolean => v !== undefined && TRACK_TOKENS.has(v)

export function Badge(props: BoxProps & { tone?: Tone | undefined }) {
  const rest = restProps(props, ['tone', 'class'])
  return <span data-ui="badge" data-tone={props.tone} class={props.class} {...rest}>{props.children}</span>
}

export function Grid(props: BoxProps & { min?: TrackValue | undefined, gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['min', 'gap', 'class'])
  return (
    <div
      data-layout="grid"
      data-min={isTrackToken(props.min) ? props.min : undefined}
      data-min-value={props.min && !isTrackToken(props.min) ? props.min : undefined}
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Sidebar(props: BoxProps & { side?: TrackValue | undefined, gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['side', 'gap', 'class'])
  return (
    <div
      data-layout="sidebar"
      data-side={isTrackToken(props.side) ? props.side : undefined}
      data-side-value={props.side && !isTrackToken(props.side) ? props.side : undefined}
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Split(props: BoxProps & { gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['gap', 'class'])
  return (
    <div
      data-layout="split"
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

interface BoxProps {
  class?: string | undefined
  children?: KayChild | undefined
  [attr: string]: unknown
}

function restProps(props: Record<string, unknown>, skip: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props)) {
    if (k !== 'children' && !skip.includes(k))
      out[k] = props[k]
  }
  return out
}

export function Card(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <section data-ui="card" class={props.class} {...rest}>{props.children}</section>
}

export function CardHeader(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <header data-part="header" class={props.class} {...rest}>{props.children}</header>
}

export function CardBody(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <div data-part="body" class={props.class} {...rest}>{props.children}</div>
}

export function CardFooter(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <footer data-part="footer" class={props.class} {...rest}>{props.children}</footer>
}

/** Zero-JS native `<details>` accordion (`name` enables exclusive mode natively in the browser). */
export function Accordion(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <div data-ui="accordion" class={props.class} {...rest}>{props.children}</div>
}

export function AccordionItem(props: { title: string, group?: string | undefined, open?: boolean | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  const rest = restProps(props, ['title', 'group', 'open'])
  return (
    <details name={props.group} open={props.open} {...rest}>
      <summary data-part="trigger">{props.title}</summary>
      <div data-part="content">{props.children}</div>
    </details>
  )
}

/** Zero-JS native Popover API trigger + anchored popover panel (`0 KB` client JS!). */
export interface PopoverProps {
  id: string
  triggerLabel: string
  triggerVariant?: ButtonVariant | undefined
  children?: KayChild | undefined
}

export function Popover({ id, triggerLabel, triggerVariant = 'outline', children }: PopoverProps) {
  return (
    <>
      <button
        data-ui="button"
        data-variant={triggerVariant}
        type="button"
        popovertarget={id}
      >
        {triggerLabel}
      </button>
      <div
        id={id}
        data-ui="popover"
        popover="auto"
      >
        {children}
      </div>
    </>
  )
}

// ---- Zero-JS native form controls (`0 KB` client JS!) ----

export interface CheckControlProps {
  id?: string | undefined
  name?: string | undefined
  value?: string | undefined
  label: string
  checked?: boolean | undefined
  disabled?: boolean | undefined
  class?: string | undefined
  [attr: string]: unknown
}

export function Checkbox({ id, name, value, label, checked, disabled, class: cls, ...rest }: CheckControlProps) {
  return (
    <label data-ui="checkbox" data-disabled={disabled ? 'true' : undefined} class={cls}>
      <input id={id} type="checkbox" name={name} value={value} checked={checked} disabled={disabled} {...rest} />
      <span data-part="label">{label}</span>
    </label>
  )
}

export function Switch({ id, name, value, label, checked, disabled, class: cls, ...rest }: CheckControlProps) {
  return (
    <label data-ui="switch" data-disabled={disabled ? 'true' : undefined} class={cls}>
      <input id={id} type="checkbox" role="switch" name={name} value={value} checked={checked} disabled={disabled} {...rest} />
      <span data-part="track" aria-hidden="true" />
      <span data-part="label">{label}</span>
    </label>
  )
}

export interface RadioOption {
  value: string
  label: string
  hint?: string | undefined
  disabled?: boolean | undefined
}

export interface RadioGroupProps {
  name: string
  legend?: string | undefined
  options: RadioOption[]
  defaultValue?: string | undefined
  class?: string | undefined
}

export function RadioGroup({ name, legend, options, defaultValue, class: cls }: RadioGroupProps) {
  return (
    <fieldset data-ui="radio-group" class={cls}>
      {legend && <legend data-part="legend">{legend}</legend>}
      <div data-part="options">
        {options.map(opt => (
          <label key={opt.value} data-part="option" data-disabled={opt.disabled ? 'true' : undefined}>
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={defaultValue === opt.value ? true : undefined}
              disabled={opt.disabled}
            />
            <span data-part="label">{opt.label}</span>
            {opt.hint && <span data-part="hint">{opt.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
