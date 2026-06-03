import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  base: "./",
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 4327,
  },
  build: {
    target: "esnext",
  },
})
