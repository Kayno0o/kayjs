// Accessible custom Select (listbox) primitive with keyboard navigation + hidden input for native <form> submission.

import type { Signal } from 'kay'
import { effect, onCleanup, signal } from 'kay'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  options: SelectOption[]
  value?: Signal<string> | undefined
  defaultValue?: string | undefined
  name?: string | undefined
  placeholder?: string | undefined
  ariaLabel?: string | undefined
  onChange?: ((value: string) => void) | undefined
}

export function Select({ options, value, defaultValue, name, placeholder = 'Select…', ariaLabel, onChange }: SelectProps) {
  const selected = value ?? signal(defaultValue ?? options[0]?.value ?? '')
  const open = signal(false)
  const highlighted = signal(0)
  let rootEl: HTMLElement | undefined

  const currentLabel = () => options.find(o => o.value === selected.value)?.label ?? placeholder

  const pick = (opt: SelectOption) => {
    selected.value = opt.value
    onChange?.(opt.value)
    open.value = false
  }

  effect(() => {
    if (!open.value)
      return
    const onDocClick = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node))
        open.value = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        open.value = false
        rootEl?.querySelector<HTMLElement>('[data-part="trigger"]')?.focus()
      }
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        highlighted.value = (highlighted.value + 1) % options.length
      }
      else if (e.key === 'ArrowUp') {
        e.preventDefault()
        highlighted.value = (highlighted.value - 1 + options.length) % options.length
      }
      else if (e.key === 'Enter' || e.key === ' ') {
        const opt = options[highlighted.value]
        if (opt) {
          e.preventDefault()
          pick(opt)
        }
      }
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
        data-part="trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open.value ? 'true' : 'false'}
        onClick={(e) => {
          e.stopPropagation()
          open.value = !open.value
          if (open.value) {
            const cur = options.findIndex(o => o.value === selected.value)
            highlighted.value = cur >= 0 ? cur : 0
          }
        }}
      >
        <span data-part="value">{currentLabel()}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open.value && (
        <div data-part="listbox" role="listbox">
          {options.map((opt, idx) => (
            <button
              key={opt.value}
              data-part="option"
              data-selected={selected.value === opt.value ? 'true' : undefined}
              data-highlighted={highlighted.value === idx ? 'true' : undefined}
              role="option"
              type="button"
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
