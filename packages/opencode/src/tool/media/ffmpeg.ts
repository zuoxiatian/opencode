import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { Process } from "@/util/process"
import { MAX_FRAME_ATTACHMENT_BYTES, MAX_FRAME_ATTACHMENT_TOTAL_BYTES, formatBytes } from "./mime"

const DEFAULT_FRAME_COUNT = 8
const MAX_FRAME_COUNT = 16

export type VideoInfo = {
  duration?: number
  width?: number
  height?: number
}

export type ExtractedFrame = {
  filename: string
  timestamp: number
  data: Buffer
}

function clampFrameCount(input: number | undefined) {
  if (!input || !Number.isFinite(input)) return DEFAULT_FRAME_COUNT
  return Math.max(1, Math.min(MAX_FRAME_COUNT, Math.floor(input)))
}

function roundTimestamp(value: number) {
  return Math.max(0, Math.round(value * 1000) / 1000)
}

function normalizeTimestamps(input: {
  timestamps?: number[]
  startTime?: number
  endTime?: number
  maxFrames?: number
  duration?: number
}) {
  if (input.timestamps?.length) {
    return input.timestamps.filter((item) => Number.isFinite(item) && item >= 0).slice(0, MAX_FRAME_COUNT).map(roundTimestamp)
  }

  const start = Math.max(0, input.startTime ?? 0)
  const fallbackEnd = input.duration ? Math.max(start + 1, input.duration) : start + 60
  const requestedEnd = input.endTime ?? fallbackEnd
  const end = input.duration ? Math.min(Math.max(requestedEnd, start + 1), input.duration) : Math.max(requestedEnd, start + 1)
  const count = clampFrameCount(input.maxFrames)

  return Array.from({ length: count }, (_, index) => roundTimestamp(start + ((index + 1) / (count + 1)) * (end - start)))
}

async function probeVideo(filepath: string, abort?: AbortSignal): Promise<VideoInfo> {
  const result = await Process.text(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=width,height",
      "-of",
      "json",
      filepath,
    ],
    { nothrow: true, abort },
  )
  if (result.code !== 0) return {}

  const parsed = JSON.parse(result.text) as {
    format?: { duration?: string }
    streams?: Array<{ width?: number; height?: number }>
  }
  const duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined
  return {
    duration: duration && Number.isFinite(duration) ? duration : undefined,
    width: parsed.streams?.[0]?.width,
    height: parsed.streams?.[0]?.height,
  }
}

async function ensureFfmpeg(abort?: AbortSignal) {
  const result = await Process.text(["ffmpeg", "-version"], { nothrow: true, abort })
  if (result.code === 0) return
  throw new Error("Frame extraction requires ffmpeg. Install ffmpeg and make sure it is available on PATH.")
}

export async function extractFrames(input: {
  filepath: string
  timestamps?: number[]
  startTime?: number
  endTime?: number
  maxFrames?: number
  abort?: AbortSignal
}) {
  await ensureFfmpeg(input.abort)
  const info = await probeVideo(input.filepath, input.abort)
  const timestamps = normalizeTimestamps({
    timestamps: input.timestamps,
    startTime: input.startTime,
    endTime: input.endTime,
    maxFrames: input.maxFrames,
    duration: info.duration,
  })
  if (timestamps.length === 0) throw new Error("No valid frame timestamps were requested.")

  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-media-frames-"))
  try {
    const frames: ExtractedFrame[] = []
    let total = 0

    for (const [index, timestamp] of timestamps.entries()) {
      const filename = `frame-${String(index + 1).padStart(3, "0")}.jpg`
      const target = path.join(dir, filename)
      const result = await Process.text(
        [
          "ffmpeg",
          "-y",
          "-ss",
          String(timestamp),
          "-i",
          input.filepath,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1280,iw)':-2",
          "-q:v",
          "5",
          target,
        ],
        { nothrow: true, abort: input.abort },
      )
      if (result.code !== 0) {
        throw new Error(result.stderr.toString().trim() || `ffmpeg failed while extracting frame at ${timestamp}s`)
      }

      const size = (await stat(target)).size
      if (size > MAX_FRAME_ATTACHMENT_BYTES) {
        throw new Error(
          `Extracted frame ${filename} is ${formatBytes(size)}, exceeding the ${formatBytes(MAX_FRAME_ATTACHMENT_BYTES)} per-frame limit.`,
        )
      }
      total += size
      if (total > MAX_FRAME_ATTACHMENT_TOTAL_BYTES) {
        throw new Error(`Extracted frames total ${formatBytes(total)}, exceeding the ${formatBytes(MAX_FRAME_ATTACHMENT_TOTAL_BYTES)} limit.`)
      }

      frames.push({
        filename,
        timestamp,
        data: await readFile(target),
      })
    }

    return { info, frames }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
