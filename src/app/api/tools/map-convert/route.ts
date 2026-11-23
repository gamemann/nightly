import { toolViewer, toolsCli, withTempFile } from "~/server/toolsServer"

export const dynamic = "force-dynamic"

// POST multipart: file, to (target format), project?  ->  { id }. The job runs detached (`nightly map-convert --run-job`); poll tools.mapJob.
export async function POST(req: Request) {
    const form = await req.formData()
    const file = form.get("file"), to = form.get("to"), project = form.get("project")
    if (typeof project === "string" && project && !/^[\w.-]+$/.test(project)) return Response.json({ error: "bad project" }, { status: 400 })
    const auth = await toolViewer(req, "tools.run", typeof project === "string" && project ? project : undefined)
    if ("deny" in auth) return auth.deny
    if (!(file instanceof File) || !file.size) return Response.json({ error: "no file in the upload" }, { status: 400 })
    if (typeof to !== "string" || !/^[\w-]+$/.test(to)) return Response.json({ error: "choose a target format" }, { status: 400 })
    try {
        const args = ["map-convert", "", "--to", to, "--by", auth.viewer.username, "--name", file.name]
        if (typeof project === "string" && /^[\w.-]+$/.test(project)) args.push("--project", project)
        return Response.json(await withTempFile(file, (p) => { args[1] = p; return toolsCli(args) }))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
