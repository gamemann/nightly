import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execp = promisify(execFile)
/** The write path of the Assets tab: `bin/nightly assets ingest -`. The token travels in the environment, never argv. */
export async function assetsIngest(text: string, token: string, viaCookie: boolean): Promise<string> {
    const p = execp(path.join(process.cwd(), 'bin', 'nightly'), ['assets', 'ingest', '-', '--json', viaCookie ? '--require-token' : '--token-only'], {
        timeout: 120_000, env: { ...process.env, ...(token ? { NIGHTLY_PERF_TOKEN: token } : {}) }, maxBuffer: 64 << 20,
    })
    p.child.stdin?.end(text)
    try { return (await p).stdout.trim() } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new Error((err.stderr || err.message).replace(/^nightly: /, '').trim())
    }
}

/** The management path of Sources/Kinds: runs `bin/nightly assets <args> --json` so the panel and the CLI share one implementation. */
export async function assetsCli(args: string[]): Promise<unknown> {
    try {
        const { stdout } = await execp(path.join(process.cwd(), 'bin', 'nightly'), ['assets', ...args, '--json'], { timeout: 600_000, maxBuffer: 64 << 20 })
        return stdout.trim() ? JSON.parse(stdout) : {}
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new Error((err.stderr || err.message).replace(/^nightly: /, '').trim())
    }
}
