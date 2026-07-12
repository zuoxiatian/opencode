export function isKimiModel(input: { providerID: string; modelID: string }) {
  const value = `${input.providerID}/${input.modelID}`.toLowerCase()
  return value.includes("kimi") || value.includes("moonshot")
}

export function nativeVideoNote() {
  return [
    "Kimi K2.6 supports native video understanding through video_url content.",
    "For large videos, upload the file to the Moonshot file API with purpose=video and pass the returned ms:// file URL to video_url.",
    "This tool currently attaches small videos directly and refuses large videos to avoid request-body and context failures.",
  ].join("\n")
}
