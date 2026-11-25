/** @jsxImportSource kay */
// Live-region Toast stack driven by the reactive `toast` store.

import { toast } from './behaviors'

export interface ToasterProps {
  dismissLabel?: string | undefined
}

export function Toaster({ dismissLabel = 'Dismiss' }: ToasterProps = {}) {
  return (
    <div data-ui="toaster" aria-live="polite" aria-atomic="false">
      {toast.items.value.map(item => (
        <div key={item.id} data-ui="toast" data-tone={item.tone} role="status">
          <div>
            <strong data-part="title">{item.title}</strong>
            {item.description && <p data-part="description">{item.description}</p>}
          </div>
          <button
            data-part="close"
            type="button"
            aria-label={dismissLabel}
            onClick={() => toast.dismiss(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
