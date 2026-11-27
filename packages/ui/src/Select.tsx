/** @jsxImportSource @kayjs/kay */
// Accessible custom Select (listbox) primitive with aria-activedescendant navigation + hidden input for native <form> submission.

import type { Signal } from '@kayjs/kay'
import { signal } from '@kayjs/kay'
import { createListPopup, nextUiId, useFieldContext } from './behaviors'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean | undefined
}

export interface SelectProps {
  id?: string | undefined
  options: SelectOption[]
  value?: Signal<string> | undefined
  defaultValue?: string | undefined
  name?: string | undefined
  placeholder?: string | undefined
  ariaLabel?: string | undefined
  onChange?: ((value: string) => void) | undefined
}

export function Select(props: SelectProps) {
  const field = useFieldContext()
  const baseId = props.id ?? field?.id ?? nextUiId('kui-select')
  let triggerId = props.id ?? field?.id ?? `${baseId}-trigger`
  const listboxId = `${baseId}-listbox`
  const optionId = (idx: number) => `${baseId}-opt-${idx}`
  const name = props.name
  const placeholder = props.placeholder ?? 'Select…'
  const ariaLabel = props.ariaLabel

  const selected = props.value ?? signal(props.defaultValue ?? props.options[0]?.value ?? '')
  const currentLabel = () => props.options.find(o => o.value === selected.value)?.label ?? placeholder

  const pick = (opt: SelectOption) => {
    if (opt.disabled)
      return
    selected.value = opt.value
    props.onChange?.(opt.value)
    popup.close(true)
  }

  const popup = createListPopup<SelectOption>({
    items: () => props.options,
    itemId: optionId,
    isDisabled: opt => Boolean(opt.disabled),
    onSelect: pick,
    initialIndex: () => props.options.findIndex(o => o.value === selected.value && !o.disabled),
  })

  return (
    <div
      data-ui="select"
      data-state={popup.open.value ? 'open' : 'closed'}
      ref={(el) => {
        popup.setRoot(el)
        if (!props.id && !field)
          triggerId = el.closest('[data-ui="field"]')?.querySelector('label')?.htmlFor || triggerId
      }}
    >
      {name && <input type="hidden" name={name} value={selected.value} />}
      <button
        id={triggerId}
        data-part="trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={popup.open.value ? 'true' : 'false'}
        aria-controls={popup.open.value ? listboxId : undefined}
        aria-activedescendant={popup.activeDescendantId()}
        onClick={e => popup.toggle(e)}
        onKeyDown={e => popup.onTriggerKeyDown(e)}
      >
        <span data-part="value">{currentLabel()}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {popup.open.value && (
        <div
          id={listboxId}
          data-part="listbox"
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : triggerId}
          popover="auto"
          ref={popup.mountPopup}
        >
          {props.options.map((opt, idx) => (
            <button
              key={opt.value}
              id={optionId(idx)}
              data-part="option"
              data-selected={selected.value === opt.value ? 'true' : undefined}
              data-highlighted={popup.highlighted.value === idx ? 'true' : undefined}
              role="option"
              type="button"
              tabindex={-1}
              disabled={opt.disabled}
              aria-disabled={opt.disabled ? 'true' : undefined}
              aria-selected={selected.value === opt.value ? 'true' : 'false'}
              onClick={() => pick(opt)}
            >
              <span>{opt.label}</span>
              <span aria-hidden="true">{selected.value === opt.value ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
