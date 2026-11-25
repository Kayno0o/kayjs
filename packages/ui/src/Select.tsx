/** @jsxImportSource @kayjs/kay */
// Accessible custom Select (listbox) primitive with aria-activedescendant navigation + hidden input for native <form> submission.

import type { Signal } from '@kayjs/kay'
import { effect, onCleanup, signal } from '@kayjs/kay'
import { findFirstEnabledIndex, handleListKeyDown, nextUiId } from './behaviors'

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
  const open = signal(false)
  const highlighted = signal(0)
  let rootEl: HTMLElement | undefined

  const currentLabel = () => options.find(o => o.value === selected.value)?.label ?? placeholder

  const pick = (opt: SelectOption) => {
    if (opt.disabled)
      return
    selected.value = opt.value
    onChange?.(opt.value)
    open.value = false
  }

  const close = (returnFocus = false) => {
    open.value = false
    if (returnFocus)
      rootEl?.querySelector<HTMLElement>('[data-part="trigger"]')?.focus()
  }

  const activeOptionId = () => {
    const idx = highlighted.value
    if (!open.value || idx < 0 || idx >= options.length || options[idx]?.disabled)
      return undefined
    return optionId(idx)
  }

  effect(() => {
    if (!open.value)
      return
    const onDocClick = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node))
        close()
    }
    const onKey = (e: KeyboardEvent) => {
      handleListKeyDown(e, {
        items: () => options,
        activeIndex: highlighted,
        isDisabled: opt => Boolean(opt.disabled),
        onSelect: opt => pick(opt),
        onClose: returnFocus => close(returnFocus),
        selectOnSpace: true,
      })
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    })
  })

  return (
    <div
      data-ui="select"
      data-state={open.value ? 'open' : 'closed'}
      ref={(el) => { rootEl = el as HTMLElement }}
    >
      {name && <input type="hidden" name={name} value={selected.value} />}
      <button
        id={triggerId}
        data-part="trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open.value ? 'true' : 'false'}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId()}
        onClick={(e) => {
          e.stopPropagation()
          open.value = !open.value
          if (open.value) {
            const cur = options.findIndex(o => o.value === selected.value && !o.disabled)
            highlighted.value = cur >= 0 ? cur : findFirstEnabledIndex(options, o => Boolean(o.disabled))
          }
        }}
      >
        <span data-part="value">{currentLabel()}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open.value && (
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
              data-highlighted={highlighted.value === idx ? 'true' : undefined}
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
