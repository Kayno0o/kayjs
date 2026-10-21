// The products collection's store, which the tests read back.
// Set to make the loader throw, as a database down would.
export const outage: { message?: string | undefined } = {}

// Set to make the footer's loader throw.
export const footerDown = { down: false }

export const products: { slug: string, data: { name: string, color?: string, mood?: string } }[] = [{ slug: 'mug', data: { name: 'Mug', color: '#ff0000', mood: 'calm' } }]

// The shop collection's store, which the tests read back: `sku` is required and hidden by the layout.
export const shop: { slug: string, data: { name: string, price?: number, stock?: number, live?: boolean, sku: string, position?: number } }[] = [{ slug: 'lamp', data: { name: 'Lamp', price: 30, stock: 4, live: true, sku: 'L-1' } }, { slug: 'vase', data: { name: 'Vase', price: 12.5, stock: 0, live: false, sku: 'V-1' } }]

// The partners collection's store: a loaded collection a `[slug]` page lists in its sitemap.
export const partners: { slug: string, data: { name: string } }[] = [{ slug: 'acme', data: { name: 'Acme' } }]

// The sections collection's store: single entries a page reads by their slug.
export const sections: { slug: string, data: { heading: string } }[] = [{ slug: 'hero', data: { heading: 'Welcome' } }, { slug: 'unused', data: { heading: 'Nobody shows this' } }]

// The rows of the ledger collection, which keeps what a save hands it.
export const ledgerRows: { slug: string, data: { name: string, note: string | null } }[] = []
