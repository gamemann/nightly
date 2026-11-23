import type { Metadata } from 'next'
import { Sidebar } from '~/components/shell/Sidebar'
import { getViewer } from '~/server/auth'
import { TRPCProvider } from '~/trpc/react'
import './globals.css'

export const metadata: Metadata = { title: 'Nightly', description: 'Projects, tasks, agents and game tools' }

/** The shell: a night sky behind everything; the sidebar only for a signed-in viewer (the login page renders bare). */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const v = await getViewer()
    return (
        <html lang="en" className="dark">
            <body className="night-sky min-h-screen">
                <div className="starfield" aria-hidden />
                <TRPCProvider>
                    {v ? (
                        <div className="relative z-10 flex min-h-screen">
                            <Sidebar viewer={{ username: v.username, name: v.name, perms: v.perms, admin: v.admin }} />
                            <main className="min-w-0 flex-1 pt-12 md:pt-0">{children}</main>
                        </div>
                    ) : <div className="relative z-10">{children}</div>}
                </TRPCProvider>
            </body>
        </html>
    )
}
