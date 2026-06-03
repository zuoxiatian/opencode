import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"

export default {
  plugins: [
    tailwindcss(),
    solid(),
  ],
  resolve: {
    preserveSymlinks: false,
  },
}
