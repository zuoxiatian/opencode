const DISABLE_BROWSER_ORIGIN_GUARD = true

export function shouldEnforceBrowserOriginGuard() {
    return !DISABLE_BROWSER_ORIGIN_GUARD
}