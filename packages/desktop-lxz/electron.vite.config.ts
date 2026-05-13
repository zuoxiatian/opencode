import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "path"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            outDir: "dist/main",
            lib: {
                entry: resolve(__dirname, "src/main/index.ts"),
                formats: ["cjs"],
                fileName: () => "index.cjs",
            },
            rollupOptions: {
                input: {
                    index: resolve(__dirname, "src/main/index.ts"),
                },
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            outDir: "dist/preload",
            lib: {
                entry: resolve(__dirname, "src/preload/index.ts"),
                formats: ["cjs"],
                fileName: () => "index.cjs",
            },
            rollupOptions: {
                external: ["electron"],
            },
        },
    },
    renderer: {
        root: ".",
        build: {
            outDir: "dist/renderer",
            rollupOptions: {
                input: {
                    index: resolve(__dirname, "index.html"),
                },
            },
        },
        resolve: {
            alias: {
                "@": resolve(__dirname, "src/renderer"),
                "@opencode-ai/sdk": resolve(__dirname, "../sdk/js/src"),
                "@opencode-ai/ui/styles/tailwind": resolve(__dirname, "../ui/src/styles/tailwind/index.css"),
                "@opencode-ai/ui/styles": resolve(__dirname, "../ui/src/styles/index.css"),
                "@opencode-ai/ui/context": resolve(__dirname, "../ui/src/context"),
                "@opencode-ai/ui": resolve(__dirname, "../ui/src/components"),
                "@opencode-ai/core": resolve(__dirname, "../core/src"),
            },
        },
        plugins: [
            tailwindcss(),
            solid(),
        ],
        server: {
            host: '0.0.0.0',
            port: 5173
        }
    },
})
