import { defineConfig } from "vite";

// esnext target required: main.js uses top-level await
export default defineConfig({
  build: { target: "esnext" },
});
