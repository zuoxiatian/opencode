import path from "path"
import { isImageAttachment, isVideoAttachment, sniffAttachmentMime } from "@/util/media"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const SAMPLE_BYTES = 4096

export const MAX_DIRECT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_DIRECT_VIDEO_BYTES = 10 * 1024 * 1024
export const MAX_FRAME_ATTACHMENT_BYTES = 1024 * 1024
export const MAX_FRAME_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function mediaKind(mime: string) {
  if (isImageAttachment(mime)) return "image" as const
  if (isVideoAttachment(mime)) return "video" as const
  return undefined
}

export function directLimit(mime: string) {
  if (isImageAttachment(mime)) return MAX_DIRECT_IMAGE_BYTES
  if (isVideoAttachment(mime)) return MAX_DIRECT_VIDEO_BYTES
  return 0
}

export function fallbackMime(filepath: string) {
  const ext = path.extname(filepath).toLowerCase()
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4"
  if (ext === ".mov" || ext === ".qt") return "video/quicktime"
  if (ext === ".webm") return "video/webm"
  if (ext === ".avi") return "video/x-msvideo"
  if (ext === ".mpeg" || ext === ".mpg") return "video/mpeg"
  return AppFileSystem.mimeType(filepath)
}

export function sniffMediaMime(filepath: string, sample: Uint8Array) {
  return sniffAttachmentMime(sample, fallbackMime(filepath))
}

export function sampleSize(fileSize: number) {
  return Math.min(SAMPLE_BYTES, fileSize)
}
