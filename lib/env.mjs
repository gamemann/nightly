// Loads the repository's .env (the file the panel reads too) into process.env, so the CLI --
// and the runner it starts under cron's bare environment -- sees NIGHTLY_DB, NIGHTLY_WORKSPACE
// and the rest. Variables already set win; no file is fine. Import it before anything that
// reads process.env at load time.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

try {
    process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'))
} catch {
    // no .env
}
