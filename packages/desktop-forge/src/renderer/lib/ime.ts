export const isIMECompositionEvent = (event: KeyboardEvent) => {
    return event.isComposing || event.keyCode === 229
}
