<script setup lang="ts">
import { formatPrice } from '../../../../shared/data'

const { data: products } = await useFetch('/api/products', { default: () => [] })
</script>

<template>
  <SiteLayout page="products">
    <h1>Products</h1>
    <p class="summary">{{ products.length }} products</p>
    <BenchCounter :start="0" />
    <ul class="products">
      <li v-for="product of products" :key="product.id" class="product">
        <h2>{{ product.name }}</h2>
        <p class="price">{{ formatPrice(product.price) }}</p>
        <p :class="`stock ${product.stock === 0 ? 'out' : 'in'}`">{{ product.stock }} in stock</p>
        <ul class="tags">
          <li v-for="tag of product.tags" :key="tag">{{ tag }}</li>
        </ul>
      </li>
    </ul>
  </SiteLayout>
</template>
