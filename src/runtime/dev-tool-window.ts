import type { DevLayout, DevState, Dock, Room } from './dev-tool-layout'
import type { Shell } from './dev-tool-shell'
import { setIcon } from './dev-tool-icons'
import { ARROWS, BAR_HEIGHT, boxOf, clamp, DRAG_START, fitBox, follow, KEY_GRIPS, KEY_STEP, MARGIN, MIN_HEIGHT, MIN_WIDTH, NARROW, PAGE_LEFT, resized, snapped } from './dev-tool-layout'

// Where the bar and the drawer sit in the window and how they move: the corner, the dock, the size, dragging the bar and the head, resizing from an edge. Split from dev-tool.ts, which opens and closes them.

export interface Placement {
  // Lays the bar and drawer out as the layout says, within the window as it is now.
  place: () => void
  // Whether the press that just ended dragged the bar, so its click opens nothing.
  dragged: () => boolean
}

export function startPlacement(doc: Document, win: Window, state: DevState, layout: DevLayout, saveLayout: () => void, shell: Shell, pageSheet: CSSStyleSheet): Placement {
  const { ui, bar, mark, drawer, head, size, docks, grips } = shell
  // The window less its scrollbars, which a fixed element's edges stop at.
  const room = (): Room => ({ width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight })
  // A narrow window spans the drawer whatever the layout says.
  const dockOf = (): Dock => win.innerWidth > NARROW ? layout.dock : 'float'
  const dockSize = (value: number) => dockOf() === 'bottom' ? clamp(value, MIN_HEIGHT, room().height - PAGE_LEFT) : clamp(value, MIN_WIDTH, room().width - PAGE_LEFT)
  let padding = ''
  let maxed: boolean | undefined
  const place = () => {
    const current = dockOf()
    const floating = current === 'float'
    const docked = floating ? 0 : dockSize(current === 'bottom' ? layout.bottom : layout.right)
    // A floating drawer the pointer can move and resize, which a narrow window spans instead.
    const free = floating && !layout.max && win.innerWidth > NARROW
    const box = free && layout.box !== undefined ? fitBox(layout.box, room()) : undefined
    const keyGrip = KEY_GRIPS[current]
    // What the bar takes of a bottom corner, its margin and measured height, published as `--kay-dev-bar-bottom-<side>` for the page's own fixed elements at that corner to keep clear of it; nothing is published for a top corner, nor for a corner the bar is not in.
    const corner = layout.corner.startsWith('bottom') ? ` --kay-dev-bar-${layout.corner}: ${MARGIN + (bar.getBoundingClientRect().height || BAR_HEIGHT)}px;` : ''
    const sheet = `html {${corner}${state.open && !floating ? ` padding-${current}: ${docked}px !important; --kay-dev-inset-${current}: ${docked}px;` : ''} }`

    ui.classList.toggle('right', layout.corner.endsWith('right'))
    ui.classList.toggle('top', layout.corner.startsWith('top'))
    ui.classList.toggle('floating', free)
    ui.classList.toggle('max', floating && layout.max)
    ui.classList.toggle('dock-bottom', current === 'bottom')
    ui.classList.toggle('dock-right', current === 'right')
    ui.classList.toggle('open', state.open)
    ui.style.setProperty('--dock', `${docked}px`)
    drawer.style.left = box === undefined ? '' : `${box.left}px`
    drawer.style.top = box === undefined ? '' : `${box.top}px`
    drawer.style.width = box === undefined ? '' : `${box.width}px`
    drawer.style.height = box === undefined ? '' : `${box.height}px`
    drawer.style.right = drawer.style.bottom = box === undefined ? '' : 'auto'
    size.hidden = !floating

    if (sheet !== padding) {
      padding = sheet
      pageSheet.replaceSync(sheet)
    }

    if (layout.max !== maxed) {
      maxed = layout.max
      setIcon(size, layout.max ? 'Restore the size' : 'Fill the window', layout.max ? 'minimize-2' : 'maximize-2')
    }

    for (const { value, button } of docks)
      button.setAttribute('aria-pressed', String(layout.dock === value))

    for (const grip of grips) {
      const edge = grip.dataset.edge!
      const reached = edge === keyGrip

      grip.hidden = floating ? !free : !reached
      grip.tabIndex = reached ? 0 : -1

      if (reached) {
        grip.setAttribute('role', 'separator')
        grip.setAttribute('aria-label', 'Resize the dev tools, arrow keys')
        grip.setAttribute('aria-orientation', edge === 'n' ? 'horizontal' : 'vertical')
        // The height for the top edge, else the width, which the corner's left and right arrows change.
        grip.setAttribute('aria-valuemin', String(edge === 'n' ? MIN_HEIGHT : MIN_WIDTH))
        grip.setAttribute('aria-valuemax', String(edge === 'n' ? room().height : room().width))
        grip.setAttribute('aria-valuenow', String(Math.round(edge === 'n' ? drawer.offsetHeight : drawer.offsetWidth)))
      }
      else {
        for (const name of ['role', 'aria-label', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow'])
          grip.removeAttribute(name)
      }
    }
  }

  // A press on the mark that moves past a few pixels drags the bar, landing it in the nearest corner, and opens nothing.
  let dragged = false

  mark.onpointerdown = (event) => {
    if (event.button !== 0)
      return

    const start = bar.getBoundingClientRect()

    dragged = false
    follow(event, mark, (dx, dy) => {
      if (!dragged && Math.hypot(dx, dy) < DRAG_START)
        return

      dragged = true
      bar.style.left = `${start.left + dx}px`
      bar.style.top = `${start.top + dy}px`
      bar.style.right = bar.style.bottom = 'auto'
    }, () => {
      if (!dragged)
        return

      // The click that ends the press comes next, in this same task; a drag ended elsewhere gets none, and must not swallow the next one.
      win.setTimeout(() => {
        dragged = false
      })

      const box = bar.getBoundingClientRect()

      layout.corner = `${box.top + box.height / 2 < room().height / 2 ? 'top' : 'bottom'}-${box.left + box.width / 2 < room().width / 2 ? 'left' : 'right'}`
      bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = ''
      saveLayout()
      place()
    })
  }
  size.onclick = () => {
    layout.max = !layout.max
    saveLayout()
    place()
  }

  // Through the entry, not a destructured binding: tsgo's declaration emit panics on a property assigned to one.
  for (const entry of docks) {
    entry.button.onclick = () => {
      layout.dock = entry.value
      saveLayout()
      place()
    }
  }

  // The head of a floating drawer moves it, snapping it to an edge near where it is let go.
  head.onpointerdown = (event) => {
    if (event.button !== 0 || !ui.classList.contains('floating') || (event.target as Element).closest('button') !== null)
      return

    const start = boxOf(drawer)
    // A press that does not move leaves a drawer that was never moved where its corner puts it.
    let moved = false

    event.preventDefault()
    follow(event, head, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < DRAG_START)
        return

      moved = true
      layout.box = fitBox({ ...start, left: start.left + dx, top: start.top + dy }, room())
      place()
    }, () => {
      if (!moved)
        return

      layout.box = snapped(fitBox(layout.box ?? start, room()), room())
      saveLayout()
      place()
    })
  }

  // Each edge and corner resizes the drawer as the pointer moves it; the one the keyboard reaches resizes it by arrow keys.
  const resizeFrom = (edge: string) => {
    const start = boxOf(drawer)

    return (dx: number, dy: number) => {
      const current = dockOf()

      if (current === 'bottom')
        layout.bottom = dockSize(start.height - dy)
      else if (current === 'right')
        layout.right = dockSize(start.width - dx)
      else
        layout.box = fitBox(resized(start, edge, dx, dy, room()), room())

      place()
    }
  }

  for (const grip of grips) {
    grip.onpointerdown = (event) => {
      if (event.button !== 0)
        return

      event.preventDefault()
      follow(event, grip, resizeFrom(grip.dataset.edge!), saveLayout)
    }
    grip.onkeydown = (event) => {
      const arrow = ARROWS[event.key]

      if (arrow === undefined)
        return

      event.preventDefault()
      resizeFrom(grip.dataset.edge!)(arrow[0] * KEY_STEP, arrow[1] * KEY_STEP)
      saveLayout()
    }
  }

  return { place, dragged: () => dragged }
}
