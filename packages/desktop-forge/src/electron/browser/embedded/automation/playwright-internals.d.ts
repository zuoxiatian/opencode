declare module "opencode-playwright-injected-source" {
    export const source: string
}

declare module "opencode-playwright-locator-utils" {
    export function getByLabelSelector(text: string, options?: { exact?: boolean }): string
    export function getByPlaceholderSelector(text: string, options?: { exact?: boolean }): string
    export function getByRoleSelector(role: string, options?: { exact?: boolean; name?: string }): string
    export function getByTestIdSelector(attribute: string, value: string): string
    export function getByTextSelector(text: string, options?: { exact?: boolean }): string
}
