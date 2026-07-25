const connection = (() => {
  const endpoint = process.env.OPENCODE_DESKTOP_BROWSER_URL
  const token = process.env.OPENCODE_DESKTOP_BROWSER_TOKEN
  delete process.env.OPENCODE_DESKTOP_BROWSER_URL
  delete process.env.OPENCODE_DESKTOP_BROWSER_TOKEN
  if (!endpoint || !token) return
  return Object.freeze({ endpoint, token })
})()

export const DESKTOP_BROWSER_AVAILABLE = connection !== undefined

export function desktopBrowserConnection() {
  return connection
}
