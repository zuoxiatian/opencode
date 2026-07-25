import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      bufferutil: fileURLToPath(new URL(
        "./src/electron/browser/embedded/automation/ws-bufferutil.ts",
        import.meta.url,
      )),
      "utf-8-validate": fileURLToPath(new URL(
        "./src/electron/browser/embedded/automation/ws-utf8-validate.ts",
        import.meta.url,
      )),
      "opencode-playwright-injected-source": fileURLToPath(new URL(
        "./node_modules/playwright-core/lib/generated/injectedScriptSource.js",
        import.meta.url,
      )),
      "opencode-playwright-locator-utils": fileURLToPath(new URL(
        "./node_modules/playwright-core/lib/utils/isomorphic/locatorUtils.js",
        import.meta.url,
      )),
    },
  },
})
