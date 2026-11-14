import type { NextConfig } from 'next'

// Hostnames the panel is opened by in `npm run dev`, comma-separated, e.g.
// NIGHTLY_DEV_ORIGINS=my-dev-box. Since Next 16 the dev server answers 403 to its own
// script chunks requested from any origin not listed here, so opening the panel as
// http://<hostname>:3010 rather than localhost delivers the HTML and then never hydrates:
// it sits on "Loading" with no error shown. Read from the environment (or .env, which Next
// loads before this file) because the hostname is a fact about one machine, not about the
// panel. Only `npm run dev` checks it; `npm run start` does not.
const devOrigins = (process.env.NIGHTLY_DEV_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const config: NextConfig = {
    // The owner's name, for the browser bundle too (see src/lib/constants.ts).
    env: { NEXT_PUBLIC_NIGHTLY_OWNER: process.env.NIGHTLY_OWNER ?? '' },
    serverExternalPackages: ['better-sqlite3', '@prisma/adapter-better-sqlite3'],
    allowedDevOrigins: devOrigins,
}

export default config
