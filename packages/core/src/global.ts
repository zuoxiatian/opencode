import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"

const home = process.env.OPENCODE_TEST_HOME ?? os.homedir()
const root = path.join(home, ".lxz")
const data = path.join(root, "data")
const cache = path.join(root, "cache")
const config = path.join(root, "config")
const state = path.join(root, "state")

const paths = {
  get home() {
    return home
  },
  root,
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly root: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly bin: string
  readonly log: string
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      home: Path.home,
      root: Path.root,
      data: Path.data,
      cache: Path.cache,
      config: Path.config,
      state: Path.state,
      bin: Path.bin,
      log: Path.log,
    })
  }),
)

export * as Global from "./global"
