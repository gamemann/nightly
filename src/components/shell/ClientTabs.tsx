'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** Link tabs that mark the one matching the current path (prefix match). */
export function ClientTabs({ tabs }: { tabs: readonly (readonly [string, string])[] }) {
    const path = usePathname() ?? ''
    const active = tabs.map(([h]) => h).filter((h) => path === h || path.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0]
    return (
        <nav className="flex gap-1 overflow-x-auto border-b border-line/70 px-6 pt-3 text-[13px]">
            {tabs.map(([href, label]) => (
                <Link key={href} href={href} className={`whitespace-nowrap rounded-t px-3 py-1.5 ${href === active ? 'bg-hover text-fg shadow-[inset_0_-2px_0] shadow-accent' : 'text-dim hover:text-fg'}`}>{label}</Link>
            ))}
        </nav>
    )
}
