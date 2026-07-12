import { Effect, Option, Schema } from "effect"
import path from "path"
import * as Tool from "../tool"
import DESCRIPTION from "./prompt.txt"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "@/project/instance"
import { assertExternalDirectoryEffect } from "../external-directory"
import { directLimit, formatBytes, mediaKind, sampleSize, sniffMediaMime } from "./mime"
import { nativeVideoNote } from "./kimi"
import { extractFrames } from "./ffmpeg"

type MediaMetadata = {
  preview: string
  truncated: boolean
  mime: string
  kind: "image" | "video"
  size: number
  sizeLabel: string
  strategy?: "native" | "frames"
  frames?: Array<{ filename: string; timestamp: number }>
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the image or video file to inspect" }),
  strategy: Schema.Literals(["auto", "native", "frames"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("auto" as const)))
    .annotate({
      description:
        "Media handling strategy. auto/native attaches small media directly. frames extracts video frames with ffmpeg.",
    }),
  timestamps: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Optional exact video timestamps in seconds to extract as frames, for example [5, 12.5, 30].",
  }),
  startTime: Schema.optional(Schema.Number).annotate({
    description: "Optional start time in seconds for interval frame extraction.",
  }),
  endTime: Schema.optional(Schema.Number).annotate({
    description: "Optional end time in seconds for interval frame extraction.",
  }),
  maxFrames: Schema.optional(Schema.Number).annotate({
    description: "Optional maximum number of frames to extract from an interval. Defaults to 8 and is capped at 16.",
  }),
})

export const MediaInspectTool = Tool.define(
  "media_inspect",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const readSample = Effect.fn("MediaInspectTool.readSample")(function* (filepath: string, fileSize: number) {
      if (fileSize === 0) return new Uint8Array()
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(sampleSize(fileSize)), () => new Uint8Array())
        }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = path.resolve(Instance.directory, params.filePath)
          const stat = yield* fs.stat(filepath).pipe(
            Effect.catchIf(
              (err) => "reason" in err && err.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
          )

          yield* assertExternalDirectoryEffect(ctx, filepath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: stat?.type === "Directory" ? "directory" : "file",
          })

          yield* ctx.ask({
            permission: "read",
            patterns: [filepath],
            always: ["*"],
            metadata: {},
          })

          if (!stat) throw new Error(`File not found: ${filepath}`)
          if (stat.type === "Directory") throw new Error(`Cannot inspect directory as media: ${filepath}`)

          const fileSize = Number(stat.size)
          const fileSizeLabel = formatBytes(fileSize)
          const mime = sniffMediaMime(filepath, yield* readSample(filepath, fileSize))
          const kind = mediaKind(mime)
          if (!kind) throw new Error(`Unsupported media file: ${filepath} (${mime || "unknown MIME type"})`)

          const shouldExtractFrames =
            kind === "video" && (params.strategy === "frames" || (params.strategy === "auto" && fileSize > directLimit(mime)))
          if (shouldExtractFrames) {
            const result = yield* Effect.promise(() =>
              extractFrames({
                filepath,
                timestamps: params.timestamps ? [...params.timestamps] : undefined,
                startTime: params.startTime,
                endTime: params.endTime,
                maxFrames: params.maxFrames,
                abort: ctx.abort,
              }),
            )
            const output = [
              `<path>${filepath}</path>`,
              `<type>${kind}</type>`,
              `<mime>${mime}</mime>`,
              `<size>${fileSize} bytes (${fileSizeLabel})</size>`,
              result.info.duration ? `<duration>${result.info.duration.toFixed(3)} seconds</duration>` : undefined,
              result.info.width && result.info.height
                ? `<resolution>${result.info.width}x${result.info.height}</resolution>`
                : undefined,
              `<strategy>frames</strategy>`,
              "",
              "<frames>",
              result.frames.map((frame, index) => `${index + 1}: ${frame.timestamp}s (${frame.filename})`).join("\n"),
              "</frames>",
            ]
              .filter(Boolean)
              .join("\n")
            return {
              title: `${path.basename(filepath)} (${mime})`,
              output,
              metadata: {
                preview: output,
                truncated: true,
                mime,
                kind,
                size: fileSize,
                sizeLabel: fileSizeLabel,
                strategy: "frames",
                frames: result.frames.map((frame) => ({ filename: frame.filename, timestamp: frame.timestamp })),
              } as MediaMetadata,
              attachments: result.frames.map((frame) => ({
                type: "file" as const,
                mime: "image/jpeg",
                filename: frame.filename,
                url: `data:image/jpeg;base64,${frame.data.toString("base64")}`,
              })),
            }
          }

          if (params.strategy === "frames") throw new Error(`Frame extraction only supports video files: ${filepath}`)

          const limit = directLimit(mime)
          if (fileSize > limit) {
            const output = [
              `<path>${filepath}</path>`,
              `<type>${kind}</type>`,
              `<mime>${mime}</mime>`,
              `<size>${fileSize} bytes (${fileSizeLabel})</size>`,
              "",
              `The ${kind} is too large to attach directly to the model. Direct ${kind} attachment limit is ${formatBytes(limit)}.`,
              kind === "video" ? nativeVideoNote() : "Use a smaller image, compression, cropping, or provider-specific upload workflow.",
            ].join("\n")
            return {
              title: `${path.basename(filepath)} (${mime})`,
              output,
              metadata: {
                preview: output,
                truncated: true,
                mime,
                kind,
                size: fileSize,
                sizeLabel: fileSizeLabel,
              } as MediaMetadata,
            }
          }

          const output = [
            `<path>${filepath}</path>`,
            `<type>${kind}</type>`,
            `<mime>${mime}</mime>`,
            `<size>${fileSize} bytes (${fileSizeLabel})</size>`,
            "",
            `${kind === "video" ? "Video" : "Image"} attached successfully for direct multimodal model input.`,
            kind === "video" ? nativeVideoNote() : undefined,
          ]
            .filter(Boolean)
            .join("\n")

          return {
            title: `${path.basename(filepath)} (${mime})`,
            output,
            metadata: {
              preview: output,
              truncated: false,
              mime,
              kind,
              size: fileSize,
              sizeLabel: fileSizeLabel,
              strategy: "native",
            } as MediaMetadata,
            attachments: [
              {
                type: "file" as const,
                mime,
                filename: path.basename(filepath),
                url: `data:${mime};base64,${Buffer.from(yield* fs.readFile(filepath)).toString("base64")}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
