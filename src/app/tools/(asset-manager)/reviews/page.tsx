import Link from "next/link"
import { Suspense } from "react"
import { Qa } from "~/components/Qa"
import { Reviews } from "~/components/Reviews"
import { Screenshots } from "~/components/Screenshots"
import { db } from "~/server/db"
import { reviewPage } from "~/server/reviewIndex"
import { guard } from '~/server/pageGuard'

export const dynamic = "force-dynamic"

const TABS = [["", "Reviews"], ["media", "Media / evidence"], ["qa", "QA"]] as const

/** Reviews, the media evidence behind them and the QA gate runs live on one page; /screenshots and /qa redirect here. */
export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const no = await guard('tools.view')
    if (no) return no
    const sp = await searchParams
    const tab = typeof sp.tab === "string" ? sp.tab : ""
    const body = tab === "media" ? <Screenshots /> : tab === "qa" ? <Suspense><Qa /></Suspense> : await reviewList(sp)
    return (
        <div>
            <nav className="flex gap-1 border-b border-line px-6 pt-4 text-[13px]">
                {TABS.map(([k, label]) => (
                    <Link key={k} href={k ? `/tools/reviews?tab=${k}` : "/tools/reviews"} className={`rounded-t px-3 py-1.5 ${tab === k ? "bg-hover text-fg" : "text-dim hover:text-fg"}`}>{label}</Link>
                ))}
            </nav>
            {body}
        </div>
    )
}

async function reviewList(sp: Record<string, string | string[] | undefined>) {
    return <Suspense><Reviews data={await reviewPage(db, sp)} /></Suspense>
}
