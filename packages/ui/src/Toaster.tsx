// Live-region Toast stack driven by the reactive `toast` store.

import { toast } from './behaviors'

export function Toaster() {
  return (
    <div data-ui="toaster" aria-live="polite" aria-atomic="false">
      {toast.items.value.map(item => (
        <div key={item.id} data-ui="toast" data-tone={item.tone} role="status">
          <div>
            <strong data-part="title">{item.title}</strong>
            {item.description && <p data-part="description" style="margin:0.2rem 0 0">{item.description}</p>}
          </div>
          <button
            data-part="close"
            type="button"
            aria-label="Dismiss"
            style="background:transparent;border:0;color:inherit;cursor:pointer;padding:0 0.25rem"
            onClick={() => toast.dismiss(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
