// A page's own cut states the layer order, as Tailwind's does; the recipe block is shared by every page and declares a layer of its own first.
export const recipe = '@layer properties; @layer utilities.recipe { .recipe { color: rgb(1, 2, 3); } }'

export const cut = (pad: number) => `@layer theme, base, components, utilities; @layer base { .box { padding: 0; } } @layer utilities { .pad { padding: ${pad}px; } }`
