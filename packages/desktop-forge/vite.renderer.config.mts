import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"

export default {
  plugins: [
    tailwindcss(),
    solid(),
  ],
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  resolve: {
    conditions: ["module", "browser", "development|production"],
    dedupe: ["solid-js"],
    preserveSymlinks: false,
  },
}
