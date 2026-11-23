// Runs once when the panel's server starts. On the Node runtime it first makes the databases ready
// (lib/bootstrap.mjs: SQLite tables and columns, usage tables, ClickHouse, roles and the first admin; a child
// process because the panel must not load node:sqlite; NIGHTLY_BOOTSTRAP=off skips it), starts the node
// connection manager (src/server/nodeManager.ts), then the built-in scheduler (src/server/scheduler.ts),
// unless NIGHTLY_SCHEDULER=off.
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    if (process.env.NIGHTLY_BOOTSTRAP !== 'off') {
        const { spawn } = await import('node:child_process')
        const path = await import('node:path')
        const script = path.join(process.cwd(), 'lib', 'bootstrap.mjs')
        const code = await new Promise<number>((resolve) => {
            const p = spawn(process.execPath, ['--no-warnings', script], { stdio: 'inherit', env: process.env })
            p.on('error', (e) => { console.error(`[bootstrap] could not start: ${e.message}`); resolve(1) })
            p.on('exit', (c) => resolve(c ?? 1))
        })
        if (code !== 0) console.error(`[bootstrap] exited with ${code}; the panel starts anyway`)
    }
    const { ensureBootstrap } = await import('./server/bootstrap')
    await ensureBootstrap()
    try {
        const { startNodeManager } = await import('./server/nodeManager')
        startNodeManager()
    } catch (e) { console.error(`[nodes] manager not started: ${(e as Error).message}`) }
    if (process.env.NIGHTLY_SCHEDULER !== 'off') {
        const { startScheduler } = await import('./server/scheduler')
        startScheduler()
    }
}
