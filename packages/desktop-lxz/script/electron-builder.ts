import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { signingEnv } from "./local-env.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bun = process.env.BUN_PATH ?? "bun"
const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--")

await run([bun, "run", "electron-builder", ...args])

async function run(cmd: string[]) {
    console.log(`$ ${cmd.join(" ")}`)

    const env = await signingEnv(packageDir)
    const code = await new Promise<number>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
            cwd: packageDir,
            env,
            stdio: "inherit",
        })

        proc.on("error", reject)
        proc.on("exit", (code) => resolve(code ?? 0))
    })

    if (code !== 0) throw new Error(`Command failed (${code}): ${cmd.join(" ")}`)
}
