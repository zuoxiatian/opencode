import * as InstanceState from "@/effect/instance-state"
import { AppRuntime } from "@/effect/app-runtime"
import { Project } from "@/project/project"
import { InstanceBootstrap } from "@/project/bootstrap"
import { ProjectID } from "@/project/schema"
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "./auth"
import { markInstanceForDisposal, markInstanceForReload } from "./lifecycle"

const root = "/project"

export const ProjectPaths = {
  list: root,
  current: `${root}/current`,
  initGit: `${root}/git/init`,
  update: `${root}/:projectID`,
  remove: `${root}/:projectID`,
} as const

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", ProjectPaths.list, {
          success: Schema.Array(Project.Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", ProjectPaths.current, {
          success: Project.Info,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
        HttpApiEndpoint.post("initGit", ProjectPaths.initGit, {
          success: Project.Info,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", ProjectPaths.update, {
          params: { projectID: ProjectID },
          payload: Project.UpdatePayload,
          success: Project.Info,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.delete("remove", ProjectPaths.remove, {
          params: { projectID: ProjectID },
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.delete",
            summary: "Delete project",
            description: "Delete an OpenCode project record and its associated sessions without deleting files on disk.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

export const projectHandlers = HttpApiBuilder.group(ProjectApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
        init: () => AppRuntime.runPromise(InstanceBootstrap),
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID })
    })

    const remove = Effect.fn("ProjectHttpApi.remove")(function* (ctx: { params: { projectID: ProjectID } }) {
      const current = yield* InstanceState.context
      yield* svc.remove(ctx.params.projectID)
      if (current.project.id === ctx.params.projectID) yield* markInstanceForDisposal(current)
      return true
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("remove", remove)
  }),
)
