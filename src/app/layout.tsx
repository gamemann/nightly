import type { Metadata } from 'next'
import { Sidebar } from '~/components/Sidebar'
import { TRPCProvider } from '~/trpc/react'
import './globals.css'

export const metadata: Metadata = { title: 'nightly', description: "The nightly run's to-do list" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className="dark">
            <body className="min-h-screen">
                <TRPCProvider>
                    <div className="flex min-h-screen">
                        <Sidebar />
                        <main className="min-w-0 flex-1">{children}</main>
                    </div>
                </TRPCProvider>
            </body>
        </html>
    )
}
