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
    // Asset and map uploads pass through the auth proxy, which buffers request bodies (10 MB by default and then truncates).
    // Per-file limits are the uploadMaxMb settings; this only has to be above them.
    experimental: { proxyClientMaxBodySize: '4gb' },
    // The redesign moved every page under a section (tasks, transcripts, automation, tools, admin).
    // Old links and bookmarks keep working; not permanent, so browsers don't pin them while the
    // tree still settles.
    redirects: async () => [
        ...['queue', 'in-progress', 'review', 'blocked', 'issues', 'done', 'all'].map((v) => ({ source: `/${v}`, destination: `/tasks/${v}`, permanent: false })),
        ...[
            ['/checks', '/automation/checks'],
            ['/releases', '/automation/workflows'],
            ['/agents', '/transcripts/agents'],
            ['/game', '/projects?type=game'],
            ['/game/:slug', '/projects/:slug/tasks'],
            ['/perf/:path*', '/tools/perf/:path*'],
            ['/assets/:path*', '/tools/assets/:path*'],
            ['/maps/:path*', '/tools/maps/:path*'],
            ['/crashes', '/tools/crashes'],
            ['/playtests', '/tools/playtest'],
            ['/rsi', '/tools/rsi'],
            ['/reviews', '/tools/reviews'],
            ['/content', '/tools/content'],
            ['/screenshots', '/tools/reviews?tab=media'],
            ['/qa', '/tools/reviews?tab=qa'],
            ['/admin', '/admin/schedules'],
            ['/schedules', '/admin/schedules'],
            ['/prompts/:path*', '/admin/prompts/:path*'],
            ['/jobs/:path*', '/admin/jobs/:path*'],
            ['/runs/:path*', '/admin/runs/:path*'],
            ['/web', '/admin/web'],
            ['/settings', '/admin/settings'],
        ].map(([source, destination]) => ({ source, destination, permanent: false })),
    ],
}

export default config
