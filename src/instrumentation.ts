// Runs once when the panel's server starts. On the Node runtime it creates the users/projects/nodes
// tables and the first admin if needed (src/server/bootstrap.ts), then starts the built-in
// scheduler (src/server/scheduler.ts), unless NIGHTLY_SCHEDULER=off.
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    const { ensureBootstrap } = await import('./server/bootstrap')
    await ensureBootstrap()
    if (process.env.NIGHTLY_SCHEDULER !== 'off') {
        const { startScheduler } = await import('./server/scheduler')
        startScheduler()
    }
}
