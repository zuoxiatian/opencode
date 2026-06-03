const { execFileSync } = require("node:child_process")
const path = require("node:path")

module.exports = async function notarizeDmg(context) {
    if (process.platform !== "darwin") return
    if (process.env.OPENCODE_DESKTOP_NOTARIZE_DMG !== "1") {
        console.log("skipping dmg notarization; set OPENCODE_DESKTOP_NOTARIZE_DMG=1 to enable")
        return
    }

    for (const dmg of context.artifactPaths.filter((artifact) => artifact.endsWith(".dmg"))) {
        console.log(`notarizing dmg ${path.basename(dmg)}`)
        execFileSync("xcrun", [
            "notarytool",
            "submit",
            dmg,
            "--wait",
            ...authArgs(),
        ], { stdio: "inherit" })

        console.log(`stapling dmg ${path.basename(dmg)}`)
        execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" })
        execFileSync("xcrun", ["stapler", "validate", dmg], { stdio: "inherit" })
    }
}

function authArgs() {
    if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
        return [
            "--apple-id",
            process.env.APPLE_ID,
            "--password",
            process.env.APPLE_APP_SPECIFIC_PASSWORD,
            "--team-id",
            process.env.APPLE_TEAM_ID,
        ]
    }

    if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
        return [
            "--key",
            process.env.APPLE_API_KEY,
            "--key-id",
            process.env.APPLE_API_KEY_ID,
            "--issuer",
            process.env.APPLE_API_ISSUER,
        ]
    }

    throw new Error("Missing Apple notarization credentials for DMG notarization")
}
