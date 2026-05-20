const { execFileSync } = require("child_process")

exports.sign = async function sign(configuration) {
    console.log(`ad-hoc signing ${configuration.app}`)

    execFileSync("/usr/bin/codesign", [
        "--force",
        "--deep",
        "--sign",
        "-",
        configuration.app,
    ], { stdio: "inherit" })
}
