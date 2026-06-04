import { spawn } from "node:child_process"

type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export async function run(cmd: string[], options: RunOptions = {}) {
  console.log(`$ ${cmd.join(" ")}`)

  const code = await new Promise<number>((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    })

    proc.on("error", reject)
    proc.on("exit", (code) => resolve(code ?? 0))
  })

  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd.join(" ")}`)
}

export async function capture(cmd: string[], env = process.env) {
  console.log(`$ ${cmd.join(" ")}`)

  return new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = []
    const proc = spawn(cmd[0], cmd.slice(1), {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    })

    proc.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    proc.on("error", () => resolve(undefined))
    proc.on("exit", (code) => {
      if (code !== 0) return resolve(undefined)
      resolve(Buffer.concat(chunks).toString("utf8").trim())
    })
  })
}
