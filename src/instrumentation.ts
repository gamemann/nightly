// Next calls register() once per runtime. The Node-only startup lives in instrumentation-node.ts and is
// imported inside this exact NEXT_RUNTIME check, so the bundler drops it from the edge build (an early
// return is not enough: webpack would still bundle Prisma and better-sqlite3 for the edge).
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { registerNode } = await import('./instrumentation-node')
        await registerNode()
    }
}
