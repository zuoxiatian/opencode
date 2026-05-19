(() => {
  const storedThemeMode = localStorage.getItem("desktop-lxz.theme")
  const themeMode = storedThemeMode === "light" || storedThemeMode === "dark" || storedThemeMode === "system"
    ? storedThemeMode
    : "system"
  const resolvedTheme = themeMode === "system"
    ? window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    : themeMode
  const backgroundColor = resolvedTheme === "light" ? "#ffffff" : "#181818"
  const style = document.createElement("style")

  document.documentElement.dataset.theme = resolvedTheme
  document.documentElement.dataset.themeMode = themeMode
  document.documentElement.style.colorScheme = resolvedTheme
  document.documentElement.style.background = backgroundColor
  style.textContent = `html, body, #root { background: ${backgroundColor}; }`
  document.head.appendChild(style)
})()
