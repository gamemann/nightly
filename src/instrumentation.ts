// Runs once when the panel's server starts. On the Node runtime it starts the built-in
// scheduler (src/server/scheduler.ts), unless NIGHTLY_SCHEDULER=off.
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NIGHTLY_SCHEDULER !== 'off') {
        const { startScheduler } = await import('./server/scheduler')
        startScheduler()
    }
}
