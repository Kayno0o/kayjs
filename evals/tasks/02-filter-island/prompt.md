# Task 02: Interactive Product Filter & Sort Island

Build a product catalog page at `/` that loads product data on the server with `load()` and hydrates a lightweight interactive filter & sort island under `--max-js 15kb`.

## Requirements

1. **Server Data Loading (`src/routes/index.tsx`)**:
   - Export `async function load()` returning at least 6 products, each with `{ id: string, name: string, category: string, price: number, inStock: boolean }` across at least 3 categories.
   - Pass the products to an interactive island component (e.g. `src/components/ProductFilter.tsx`).
   - Include `<Head><title>Product Catalog</title></Head>` in the route (not inside the island).

2. **Interactive Island (`src/components/ProductFilter.tsx`)**:
   - Use `signal`, `computed`, and `useId` from `@kayjs/kay` (no client directives — Kay detects islands automatically).
   - Provide accessible controls wired with `useId` (`<label for={...}>` + matching `id={...}`):
     - Text search input filtering by product name
     - Category `<select>` dropdown (`All` + each category)
     - Sort `<select>` (`Price: Low to High`, `Price: High to Low`, `Name A–Z`)
     - In-stock only checkbox
   - Derive the filtered & sorted list with `computed(() => ...)` and render it with reactive `.map()` using `key={product.id}`.
   - Display the count of matching products and an empty-state message when 0 match.

3. **Verification**:
   - `kay check` passes with 0 errors.
   - `kay build --analyze --max-js 15kb` passes (eager JS gzipped `<= 15 KB`).
   - `GET /` renders all initial products in SSR HTML with accessible form controls and mounts the island.
