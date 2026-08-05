import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { app, BrowserWindow, webContents } from "electron"
import type { BrowserCommandInput } from "@opencode-ai/browser-protocol"
import { createBrowserRuntime, type BrowserRuntime } from "../src/electron/browser/runtime"
import { agentBrowserSocketDir } from "../src/electron/browser/agent-browser/process-manager"
import { BrowserRuntimeException } from "../src/electron/browser/errors"

void bootstrap()

async function bootstrap() {
    app.commandLine.appendSwitch("site-per-process")
    app.setPath("userData", await mkdtemp(path.join(tmpdir(), "df-browser-runtime-poc-")))
    Object.defineProperty(app, "isPackaged", { value: true })
    if (process.env.DESKTOP_FORGE_PACKAGED_TARGET_ARCH) {
        Object.defineProperty(process, "arch", {
            value: process.env.DESKTOP_FORGE_PACKAGED_TARGET_ARCH,
        })
    }
    Object.defineProperty(process, "resourcesPath", {
        value: process.env.DESKTOP_FORGE_PACKAGED_RESOURCES_PATH
            ?? path.join(process.cwd(), "resources"),
    })
    await app.whenReady()
    await runPoc()
}

async function runPoc() {
    const frameHits = { value: 0 }
    const frame = await listen(createServer((_request, response) => {
        frameHits.value += 1
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.end(`
            <!doctype html>
            <label for="frame-query">Frame query</label>
            <input id="frame-query" placeholder="Frame search">
            <button id="frame-submit">Frame submit</button>
        `)
    }))
    const main = await listen(createServer((request, response) => {
        if (request.url === "/download") {
            response.setHeader("content-disposition", "attachment; filename=runtime-download.txt")
            response.setHeader("content-type", "text/plain; charset=utf-8")
            response.end("download payload")
            return
        }
        response.setHeader("content-type", "text/html; charset=utf-8")
        if (request.url === "/page-2") {
            response.end("<!doctype html><h1>Navigation complete</h1><button>Page two action</button>")
            return
        }
        if (request.url === "/isolated") {
            response.end(`
                <!doctype html>
                <label for="isolated-query">Isolated query</label>
                <input id="isolated-query" placeholder="Isolated search">
                <p>Second tab only</p>
            `)
            return
        }
        response.end(`
            <!doctype html>
            <label for="query">Query</label>
            <input id="query" placeholder="Search">
            <button id="dialog">Open dialog</button>
            <button id="state-target">State target</button>
            <input data-testid="upload" type="file">
            <a id="download" href="/download" download>Download file</a>
            <iframe title="Cross frame" src="http://localhost:${frame.port}/frame"></iframe>
            <p id="dialog-state">idle</p>
            <script>
                document.querySelector("#dialog").addEventListener("click", () => {
                    document.querySelector("#dialog-state").textContent = "clicked"
                    alert("runtime dialog")
                })
            </script>
        `)
    }))
    const window = new BrowserWindow({ height: 700, show: false, width: 1000 })
    const runtime = createBrowserRuntime(window)
    const upload = path.join(app.getPath("userData"), "upload.txt")
    await writeFile(upload, "upload payload")

    try {
        step("create-and-navigate")
        await command(runtime, {
            command: {
                bounds: { height: 600, width: 900, x: 0, y: 0 },
                name: "browser.viewport.set",
            },
        })
        const created = await command(runtime, { command: { name: "tabs.new" } })
        const tabId = created.data.tab?.id
        assert.ok(tabId)
        const url = `http://127.0.0.1:${main.port}/`
        const origin = new URL(url).origin
        await command(runtime, {
            command: { name: "tab.goto", url },
            tabId,
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.ok(frameHits.value > 0, "cross-origin iframe request did not reach its server")

        step("automation-and-oopif")
        const firstSnapshot = (await command(runtime, {
            command: { name: "tab.automation.snapshot" },
            expectedOrigin: origin,
            tabId,
        })).data.automationSnapshot
        step("snapshot-ready")
        assert.ok(firstSnapshot)
        step("debugger-detach-reconnect")
        const initialRenderer = webContents.getAllWebContents().find((item) => item.getURL() === url)
        assert.ok(initialRenderer?.debugger.isAttached())
        initialRenderer.debugger.detach()
        const reconnectedSnapshot = (await command(runtime, {
            command: { name: "tab.automation.snapshot" },
            expectedOrigin: origin,
            tabId,
        })).data.automationSnapshot
        assert.ok(reconnectedSnapshot)
        const attached = (await command(runtime, {
            command: {
                methods: ["Target.attachedToTarget"],
                name: "tab.dev.cdp.events",
                timeout: 1_000,
            },
            expectedOrigin: origin,
            tabId,
        })).data.cdpEvents
        await new Promise((resolve) => setTimeout(resolve, 100))
        const snapshot = reconnectedSnapshot.content.includes("Frame query")
            ? reconnectedSnapshot
            : (await command(runtime, {
                command: { name: "tab.automation.snapshot" },
                expectedOrigin: origin,
                tabId,
            })).data.automationSnapshot
        assert.ok(snapshot)
        assert.match(snapshot.content, /Query/)
        assert.match(snapshot.content, /Frame query/)
        const searchRef = snapshot.content.match(/textbox "Query" \[ref=(e\d+)\]/)?.[1]
        const frameRef = snapshot.content.match(/textbox "Frame query" \[ref=(e\d+)\]/)?.[1]
        const dialogRef = snapshot.content.match(/button "Open dialog" \[ref=(e\d+)\]/)?.[1]
        const stateRef = snapshot.content.match(/button "State target" \[ref=(e\d+)\]/)?.[1]
        assert.ok(searchRef)
        assert.ok(frameRef)
        assert.ok(dialogRef)
        assert.ok(stateRef)

        step("element-state-waits-and-ref-count")
        const stateTarget = { ref: stateRef, snapshotId: snapshot.snapshotId }
        await command(runtime, {
            command: {
                name: "tab.automation.waitFor",
                state: "attached",
                target: stateTarget,
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        await command(runtime, {
            command: {
                name: "tab.automation.waitFor",
                state: "visible",
                target: stateTarget,
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.equal((await command(runtime, {
            command: { name: "tab.automation.count", target: stateTarget },
            expectedOrigin: origin,
            tabId,
        })).data.count, 1)
        await command(runtime, {
            command: {
                expression: "(() => { document.querySelector('#state-target').style.display = 'none'; return true })()",
                name: "tab.automation.waitFor",
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        await command(runtime, {
            command: {
                name: "tab.automation.waitFor",
                state: "hidden",
                target: stateTarget,
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.equal((await command(runtime, {
            command: { name: "tab.automation.count", target: stateTarget },
            expectedOrigin: origin,
            tabId,
        })).data.count, 1)
        await command(runtime, {
            command: {
                expression: "(() => { document.querySelector('#state-target').remove(); return true })()",
                name: "tab.automation.waitFor",
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        await command(runtime, {
            command: {
                name: "tab.automation.waitFor",
                state: "detached",
                target: stateTarget,
                timeout: 2_000,
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.equal((await command(runtime, {
            command: { name: "tab.automation.count", target: stateTarget },
            expectedOrigin: origin,
            tabId,
        })).data.count, 0)
        await command(runtime, {
            command: {
                name: "tab.automation.fill",
                target: { name: "Query", role: "textbox" },
                value: "semantic-role",
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.equal((await command(runtime, {
            command: {
                name: "tab.automation.getValue",
                target: { ref: searchRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })).data.value, "semantic-role")
        await command(runtime, {
            command: {
                name: "tab.automation.focus",
                target: { ref: searchRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })
        await command(runtime, {
            command: {
                name: "tab.automation.keyboard.insertText",
                text: "-keyboard",
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.equal((await command(runtime, {
            command: {
                name: "tab.automation.getValue",
                target: { ref: searchRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })).data.value, "semantic-role-keyboard")
        step("oopif-fill")
        await command(runtime, {
            command: {
                name: "tab.automation.fill",
                target: { ref: frameRef, snapshotId: snapshot.snapshotId },
                value: "inside-oopif",
            },
            expectedOrigin: origin,
            tabId,
        })
        assert.match(String((await command(runtime, {
            command: {
                name: "tab.automation.getValue",
                target: { ref: frameRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })).data.value), /inside-oopif/)
        const frameBox = (await command(runtime, {
            command: {
                name: "tab.automation.getBox",
                target: { ref: frameRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })).data.box
        assert.ok(frameBox)
        assert.ok([frameBox.x, frameBox.y, frameBox.width, frameBox.height]
            .every((value) => Number.isFinite(value)))
        const frameElementBox = (await command(runtime, {
            command: {
                name: "tab.automation.getBox",
                target: { advanced: true, css: "iframe" },
            },
            expectedOrigin: origin,
            tabId,
        })).data.box
        assert.ok(frameElementBox)
        assert.ok(frameBox.x >= frameElementBox.x)
        assert.ok(frameBox.y >= frameElementBox.y)
        assert.ok(attached?.events.some((event) =>
            typeof event.params?.sessionId === "string"
            && event.params.sessionId.length > 0))

        step("screenshot-dialog-file-download")
        const screenshot = (await command(runtime, {
            command: { name: "tab.screenshot" },
            tabId,
        })).data.screenshot
        assert.ok(screenshot)
        assert.equal(screenshot.mimeType, "image/png")
        assert.ok(screenshot.width > 0 && screenshot.height > 0)
        const elementScreenshot = (await command(runtime, {
            command: {
                name: "tab.screenshot",
                target: { advanced: true, css: "#query" },
            },
            expectedOrigin: origin,
            tabId,
        })).data.screenshot
        assert.ok(elementScreenshot?.data)
        assert.ok(elementScreenshot.width > 0 && elementScreenshot.height > 0)
        const annotated = (await command(runtime, {
            command: { annotate: true, name: "tab.screenshot" },
            expectedOrigin: origin,
            tabId,
        })).data.screenshot
        assert.ok(annotated?.data)
        assert.ok(annotated.snapshotId)
        const annotatedDialogRef = annotated.annotations
            ?.find((annotation) => annotation.name === "Open dialog")?.ref
        assert.ok(annotatedDialogRef)
        const pdf = (await command(runtime, {
            command: { name: "tab.pdf" },
            expectedOrigin: origin,
            tabId,
        })).data.pdf
        assert.equal(pdf?.mimeType, "application/pdf")
        assert.ok(pdf?.data)
        const readable = (await command(runtime, {
            command: { name: "tab.automation.read" },
            expectedOrigin: origin,
            tabId,
        })).data.readable
        assert.match(readable?.content ?? "", /Query/)
        await command(runtime, {
            command: {
                amount: 100,
                direction: "down",
                name: "tab.automation.scroll",
            },
            expectedOrigin: origin,
            tabId,
        })

        const dialogResult = await command(runtime, {
            command: {
                name: "tab.dialog.wait",
                timeout: 15_000,
                trigger: { ref: annotatedDialogRef, snapshotId: annotated.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        }).catch(async (error: unknown) => {
            const state = await command(runtime, {
                command: {
                    name: "tab.automation.getText",
                    target: { advanced: true, css: "#dialog-state" },
                    timeout: 1_000,
                },
                expectedOrigin: origin,
                tabId,
            }).catch(() => undefined)
            process.stderr.write(`browser-runtime-poc:dialog-state:${String(state?.data.value)}\n`)
            throw error
        })
        const dialog = dialogResult.data.dialog
        assert.equal(dialog?.message, "runtime dialog")
        await command(runtime, {
            command: {
                accept: true,
                dialogId: dialog.id,
                name: "tab.dialog.handle",
            },
            tabId,
        })
        const repeatSnapshot = (await command(runtime, {
            command: { name: "tab.automation.snapshot" },
            expectedOrigin: origin,
            tabId,
        })).data.automationSnapshot
        assert.ok(repeatSnapshot)
        const repeatDialogRef = repeatSnapshot.content
            .match(/button "Open dialog" \[ref=(e\d+)\]/)?.[1]
        const repeatDownloadRef = repeatSnapshot.content
            .match(/link "Download file" \[ref=(e\d+)\]/)?.[1]
        assert.ok(repeatDialogRef)
        assert.ok(repeatDownloadRef)
        const repeatedDialog = (await command(runtime, {
            command: {
                name: "tab.dialog.wait",
                timeout: 15_000,
                trigger: { ref: repeatDialogRef, snapshotId: repeatSnapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        })).data.dialog
        assert.equal(repeatedDialog?.message, "runtime dialog")
        await command(runtime, {
            command: {
                accept: true,
                dialogId: repeatedDialog.id,
                name: "tab.dialog.handle",
            },
            tabId,
        })

        const chooser = (await command(runtime, {
            command: {
                name: "tab.fileChooser.wait",
                timeout: 15_000,
                trigger: { testId: "upload" },
            },
            expectedOrigin: origin,
            tabId,
        })).data.fileChooser
        assert.ok(chooser)
        const duplicateDialog = (await command(runtime, {
            command: { name: "tab.dialog.get" },
            tabId,
        })).data.dialog
        assert.equal(duplicateDialog, null)
        await command(runtime, {
            command: {
                chooserId: chooser.id,
                filePaths: [upload],
                name: "tab.fileChooser.setFiles",
            },
            tabId,
        })
        assert.match(String((await command(runtime, {
            command: {
                name: "tab.automation.getValue",
                target: { advanced: true, css: "[data-testid=upload]" },
            },
            expectedOrigin: origin,
            tabId,
        })).data.value), /upload\.txt/)

        const download = (await command(runtime, {
            command: {
                name: "tab.download.wait",
                timeout: 15_000,
                trigger: {
                    ref: repeatDownloadRef,
                    snapshotId: repeatSnapshot.snapshotId,
                },
            },
            expectedOrigin: origin,
            tabId,
        })).data.download
        assert.ok(download)
        const completed = await completedDownload(runtime, tabId, download.id)
        assert.equal(completed.filename, "runtime-download.txt")
        assert.equal(completed.state, "completed")
        assert.ok(completed.path)

        step("two-tab-isolation")
        const isolated = await command(runtime, { command: { name: "tabs.new" } })
        const isolatedTabId = isolated.data.tab?.id
        assert.ok(isolatedTabId)
        await command(runtime, {
            command: { name: "tab.goto", url: `http://127.0.0.1:${main.port}/isolated` },
            tabId: isolatedTabId,
        })
        const [firstTabSnapshot, secondTabSnapshot] = await Promise.all([
            command(runtime, {
                command: { name: "tab.automation.snapshot" },
                expectedOrigin: origin,
                tabId,
            }),
            command(runtime, {
                command: { name: "tab.automation.snapshot" },
                expectedOrigin: origin,
                tabId: isolatedTabId,
            }),
        ])
        const firstIsolationSnapshot = firstTabSnapshot.data.automationSnapshot
        const secondIsolationSnapshot = secondTabSnapshot.data.automationSnapshot
        assert.ok(firstIsolationSnapshot)
        assert.ok(secondIsolationSnapshot)
        assert.match(firstIsolationSnapshot.content, /Query/)
        assert.doesNotMatch(firstIsolationSnapshot.content, /Isolated query/)
        assert.match(secondIsolationSnapshot.content, /Isolated query/)
        assert.doesNotMatch(secondIsolationSnapshot.content, /Open dialog/)
        const firstIsolationRef = firstIsolationSnapshot.content
            .match(/textbox "Query" \[ref=(e\d+)\]/)?.[1]
        const secondIsolationRef = secondIsolationSnapshot.content
            .match(/textbox "Isolated query" \[ref=(e\d+)\]/)?.[1]
        assert.ok(firstIsolationRef)
        assert.ok(secondIsolationRef)
        await Promise.all([
            command(runtime, {
                command: {
                    name: "tab.automation.fill",
                    target: {
                        ref: firstIsolationRef,
                        snapshotId: firstIsolationSnapshot.snapshotId,
                    },
                    value: "first-tab-only",
                },
                expectedOrigin: origin,
                tabId,
            }),
            command(runtime, {
                command: {
                    name: "tab.automation.fill",
                    target: {
                        ref: secondIsolationRef,
                        snapshotId: secondIsolationSnapshot.snapshotId,
                    },
                    value: "second-tab-only",
                },
                expectedOrigin: origin,
                tabId: isolatedTabId,
            }),
        ])
        const [firstValue, secondValue] = await Promise.all([
            command(runtime, {
                command: {
                    name: "tab.automation.getValue",
                    target: {
                        ref: firstIsolationRef,
                        snapshotId: firstIsolationSnapshot.snapshotId,
                    },
                },
                expectedOrigin: origin,
                tabId,
            }),
            command(runtime, {
                command: {
                    name: "tab.automation.getValue",
                    target: {
                        ref: secondIsolationRef,
                        snapshotId: secondIsolationSnapshot.snapshotId,
                    },
                },
                expectedOrigin: origin,
                tabId: isolatedTabId,
            }),
        ])
        assert.equal(firstValue.data.value, "first-tab-only")
        assert.equal(secondValue.data.value, "second-tab-only")
        await command(runtime, {
            command: { name: "tab.close" },
            tabId: isolatedTabId,
        })

        step("daemon-timeout-termination")
        const timeoutStarted = Date.now()
        const timedOut = await command(runtime, {
            command: {
                milliseconds: 30_000,
                name: "tab.automation.waitFor",
                timeout: 100,
            },
            expectedOrigin: origin,
            tabId,
        }).catch((error: unknown) => error)
        assert.equal(browserCode(timedOut), "TIMEOUT")
        assert.match((await command(runtime, {
            command: { name: "tab.automation.snapshot" },
            expectedOrigin: origin,
            tabId,
        })).data.automationSnapshot?.content ?? "", /Query/)
        assert.ok(Date.now() - timeoutStarted < 5_000)

        step("navigation-and-stale-ref")
        await command(runtime, {
            command: { name: "tab.goto", url: `http://127.0.0.1:${main.port}/page-2` },
            tabId,
        })
        const stale = await command(runtime, {
            command: {
                name: "tab.automation.click",
                target: { ref: searchRef, snapshotId: snapshot.snapshotId },
            },
            expectedOrigin: origin,
            tabId,
        }).catch((error: unknown) => error)
        assert.equal(browserCode(stale), "STALE_REF")
        assert.match((await command(runtime, {
            command: { name: "tab.automation.snapshot" },
            expectedOrigin: origin,
            tabId,
        })).data.automationSnapshot?.content ?? "", /Navigation complete/)

        step("finalize-and-close-during-action")
        await command(runtime, { command: { name: "tabs.finalize" } })
        assert.equal(runtime.getState().tabs.length, 0)

        const closing = await command(runtime, { command: { name: "tabs.new" } })
        const closingTabId = closing.data.tab?.id
        assert.ok(closingTabId)
        await command(runtime, {
            command: { name: "tab.goto", url },
            tabId: closingTabId,
        })
        const waiting = command(runtime, {
            command: {
                name: "tab.automation.waitFor",
                text: "never appears",
                timeout: 10_000,
            },
            expectedOrigin: origin,
            tabId: closingTabId,
        }).catch((error: unknown) => error)
        await new Promise((resolve) => setTimeout(resolve, 100))
        await command(runtime, {
            command: { name: "tab.close" },
            tabId: closingTabId,
        })
        assert.ok(["CANCELLED", "GATEWAY_UNAVAILABLE", "TARGET_GONE"].includes(
            browserCode(await waiting) ?? "",
        ))

        step("render-process-gone")
        const crashed = await command(runtime, { command: { name: "tabs.new" } })
        const crashedTabId = crashed.data.tab?.id
        assert.ok(crashedTabId)
        await command(runtime, {
            command: { name: "tab.goto", url },
            tabId: crashedTabId,
        })
        const renderer = webContents.getAllWebContents().find((item) => item.getURL() === url)
        assert.ok(renderer)
        renderer.forcefullyCrashRenderer()
        await new Promise((resolve) => setTimeout(resolve, 250))
        assert.equal((await command(runtime, {
            command: { name: "tab.state" },
            tabId: crashedTabId,
        })).data.tab?.error?.kind, "crash")
        await command(runtime, {
            command: { name: "tab.close" },
            tabId: crashedTabId,
        })

        step("shutdown")
        await runtime.destroy()
        const agentBrowserRuntimeDir = path.join(app.getPath("userData"), "agent-browser")
        assert.equal(
            await realpath(agentBrowserSocketDir(agentBrowserRuntimeDir)),
            await realpath(path.join(agentBrowserRuntimeDir, "sockets")),
        )
        assert.deepEqual(
            await readdir(path.join(
                agentBrowserSocketDir(agentBrowserRuntimeDir),
                "namespaces",
                "desktop-forge",
                "run",
            )),
            [],
        )
        process.stdout.write(JSON.stringify({
            concurrentTabs: true,
            daemonTimeoutTermination: true,
            debuggerReconnect: true,
            directPage: true,
            elementStateWaits: true,
            oopif: true,
            runtime: true,
            success: true,
        }))
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        if (error instanceof BrowserRuntimeException) {
            process.stderr.write(`${JSON.stringify(error.browser)}\n`)
        }
        process.exitCode = 1
    } finally {
        await runtime.destroy().catch(() => undefined)
        window.destroy()
        await Promise.all([close(main.server), close(frame.server)])
        app.exit(process.exitCode ?? 0)
    }
}

function command(runtime: BrowserRuntime, input: BrowserCommandInput) {
    return runtime.command(input, { sessionId: "poc-owner" })
}

async function completedDownload(runtime: BrowserRuntime, tabId: string, downloadId: string) {
    const download = (await command(runtime, {
        command: { downloadId, name: "tab.download.get" },
        tabId,
    })).data.download
    assert.ok(download)
    if (download.state === "completed") return download
    await new Promise((resolve) => setTimeout(resolve, 25))
    return completedDownload(runtime, tabId, downloadId)
}

function browserCode(error: unknown) {
    return error instanceof BrowserRuntimeException ? error.browser.code : undefined
}

function listen(server: Server) {
    return new Promise<{ port: number; server: Server }>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject)
            resolve({ port: (server.address() as AddressInfo).port, server })
        })
    })
}

function close(server: Server) {
    return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
    })
}

function step(name: string) {
    process.stderr.write(`browser-runtime-poc:${name}\n`)
}
