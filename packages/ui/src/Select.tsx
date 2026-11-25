/** @jsxImportSource @kayjs/kay */
// Accessible custom Select (listbox) primitive with aria-activedescendant navigation + hidden input for native <form> submission.

import type { Signal } from '@kayjs/kay'
import { signal } from '@kayjs/kay'
import { createListPopup, nextUiId } from './behaviors'

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

export function Select({ id, options, value, defaultValue, name, placeholder = 'Select…', ariaLabel, onChange }: SelectProps) {
  const baseId = id ?? nextUiId('kui-select')
  const triggerId = `${baseId}-trigger`
  const listboxId = `${baseId}-listbox`
  const optionId = (idx: number) => `${baseId}-opt-${idx}`

  const selected = value ?? signal(defaultValue ?? options[0]?.value ?? '')
  const currentLabel = () => options.find(o => o.value === selected.value)?.label ?? placeholder

  const pick = (opt: SelectOption) => {
    if (opt.disabled)
      return
    selected.value = opt.value
    onChange?.(opt.value)
    popup.open.value = false
  }

  const popup = createListPopup<SelectOption>({
    items: () => options,
    itemId: optionId,
    isDisabled: opt => Boolean(opt.disabled),
    onSelect: pick,
    initialIndex: () => options.findIndex(o => o.value === selected.value && !o.disabled),
  })

  return (
    <div
      data-ui="select"
      data-state={popup.open.value ? 'open' : 'closed'}
      ref={(el) => { popup.setRoot(el as HTMLElement) }}
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
        aria-controls={listboxId}
        aria-activedescendant={popup.activeDescendantId()}
        onClick={e => popup.toggle(e)}
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
        >
          {options.map((opt, idx) => (
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
              {selected.value === opt.value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
