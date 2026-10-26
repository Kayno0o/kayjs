// The test browser has no hover-capable pointer, so Tailwind's hover: rules, kept behind (hover: hover), never apply: the sheets are rewritten with that query always true, the cascade and layers kept.
export async function hoverable(page: { evaluate: (run: () => void) => Promise<unknown> }) {
  return page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode as HTMLElement | null

      if (!owner)
        continue

      const style = document.createElement('style')

      style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n').replaceAll('(hover: hover)', 'all')
      owner.after(style)
      owner.remove()
    }
  })
}

// Hovers an element and returns once the pointer is on it and the transitions the hover started have finished, so the colours read next are the settled ones.
export async function hoverOver(page: { hover: (selector: string) => Promise<unknown>, waitUntil: (condition: (selector: string) => unknown, options: undefined, selector: string) => Promise<void>, evaluate: (run: () => Promise<void>) => Promise<unknown> }, selector: string) {
  await page.hover(selector)
  await page.waitUntil(target => document.querySelector(target)?.matches(':hover'), undefined, selector)
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      try {
        await animation.finished
      }
      catch {
        // A transition a newer hover cancelled has nothing left to wait for.
      }
    }
  })
}
