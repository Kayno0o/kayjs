// The products collection's store, which the tests read back.
// Set to make the loader throw, as a database down would.
export const outage: { message?: string | undefined } = {}

export const products: { slug: string, data: { name: string, color?: string, mood?: string } }[] = [{ slug: 'mug', data: { name: 'Mug', color: '#ff0000', mood: 'calm' } }]

// The shop collection's store, which the tests read back: `sku` is required and hidden by the layout.
export const shop: { slug: string, data: { name: string, price?: number, stock?: number, live?: boolean, sku: string } }[] = [{ slug: 'lamp', data: { name: 'Lamp', price: 30, stock: 4, live: true, sku: 'L-1' } }, { slug: 'vase', data: { name: 'Vase', price: 12.5, stock: 0, live: false, sku: 'V-1' } }]
