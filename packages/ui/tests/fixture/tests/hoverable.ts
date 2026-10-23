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
