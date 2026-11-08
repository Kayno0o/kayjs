import type { DevTool } from './dev-tool'
import { boundsOf } from './dev-tool-parts'

// The box drawn around elements of the page, with a label beside the first, which the tabs that point at the page use. Split from dev-tool.ts.

export function makeOutline(root: ShadowRoot, make: DevTool['make']): Pick<DevTool, 'outline' | 'hideOutline'> {
  const label = make('div', 'label mono')
  const boxes: HTMLElement[] = []

  label.hidden = true
  root.append(label)

  const outline = (targets: Element[], text: string) => {
    for (const [index, target] of targets.entries()) {
      const box = boundsOf(target)
      const element = boxes[index] ?? root.appendChild(make('div', 'outline'))

      boxes[index] = element
      element.hidden = false
      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`

      if (index === 0) {
        label.hidden = false
        label.textContent = text
        label.style.left = `${Math.max(0, box.left)}px`
        label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 2}px`
      }
    }

    for (const box of boxes.slice(targets.length))
      box.hidden = true
  }
  const hideOutline = () => {
    label.hidden = true

    for (const box of boxes)
      box.hidden = true
  }

  return { outline, hideOutline }
}
