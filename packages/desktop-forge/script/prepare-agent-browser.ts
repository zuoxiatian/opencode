import { prepareAgentBrowser } from "./lib/agent-browser.ts"
import { packageTargetIds, runtimeTargetById } from "./lib/targets.ts"

const ids = process.argv.slice(2).filter((argument) => argument !== "--")
const targets = ids.length ? ids.map((id) => {
  const target = runtimeTargetById(id)
  if (!target) throw new Error(`Unsupported agent-browser target: ${id}`)
  return target.id
}) : [...packageTargetIds.all]

await prepareAgentBrowser(targets)
