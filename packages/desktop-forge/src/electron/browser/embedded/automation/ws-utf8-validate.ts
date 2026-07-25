export default function isValidUtf8(input: Uint8Array) {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(input)
        return true
    } catch {
        return false
    }
}
