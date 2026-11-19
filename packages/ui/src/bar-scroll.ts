// Scrolls a bar of tabs, and only the bar, so the tab is centred in it: `scrollIntoView` would also move the page to the bar.
export function centerInBar(bar: HTMLElement, item: Element, vertical: boolean): void {
  const outer = bar.getBoundingClientRect()
  const box = item.getBoundingClientRect()

  if (vertical)
    bar.scrollTop += box.top - outer.top - (outer.height - box.height) / 2
  else
    bar.scrollLeft += box.left - outer.left - (outer.width - box.width) / 2
}
