import 'dotenv/config'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

// SQLite file lives in ./data (gitignored). NIGHTLY_DB overrides it (scratch copies, tests).
const dbFile = process.env.NIGHTLY_DB || path.join(import.meta.dirname, 'data', 'nightly.db')

export default defineConfig({
    schema: 'prisma/schema.prisma',
    datasource: { url: `file:${dbFile}` },
})
