export function mask(
    source: Uint8Array,
    key: Uint8Array,
    output: Uint8Array,
    offset: number,
    length: number,
) {
    for (let index = 0; index < length; index += 1) {
        output[offset + index] = source[index] ^ key[index & 3]
    }
}

export function unmask(buffer: Uint8Array, key: Uint8Array) {
    for (let index = 0; index < buffer.length; index += 1) {
        buffer[index] ^= key[index & 3]
    }
}
