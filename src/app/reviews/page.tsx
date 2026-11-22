import Link from "next/link"
import { Qa } from "~/components/Qa"
import { Reviews } from "~/components/Reviews"
import { Screenshots } from "~/components/Screenshots"
import { db } from "~/server/db"
import { classify } from "../../../lib/classify.mjs"
import { load } from "../../../lib/review.mjs"

export const dynamic = "force-dynamic"

const TABS = [["", "Reviews"], ["media", "Media / evidence"], ["qa", "QA"]] as const

/** Reviews, the media evidence behind them and the QA gate runs live on one page; /screenshots and /qa redirect here. */
export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
    const tab = (await searchParams).tab ?? ""
    const body = tab === "media" ? <Screenshots /> : tab === "qa" ? <Qa /> : await reviewList()
    return (
        <div>
            <nav className="flex gap-1 border-b border-line px-6 pt-4 text-[13px]">
                {TABS.map(([k, label]) => (
                    <Link key={k} href={k ? `/reviews?tab=${k}` : "/reviews"} className={`rounded-t px-3 py-1.5 ${tab === k ? "bg-hover text-fg" : "text-dim hover:text-fg"}`}>{label}</Link>
                ))}
            </nav>
            {body}
        </div>
    )
}

async function reviewList() {
    const items = await db.item.findMany({ where: { kind: "review" }, orderBy: { id: "desc" }, take: 200 })
    const known = new Set<string>()
    const reviews = items.map((i) => {
        const weapons = load(i.key).weapons
        const verdicts = Object.values(weapons).map((w) => w.verdict)
        return {
            key: i.key, title: i.title, body: i.body, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(), weapons,
            game: classify(i.repos, i.key, i.title, known),
            counts: { total: verdicts.length, good: verdicts.filter((v) => v === "good").length, wrong: verdicts.filter((v) => v === "wrong").length, todo: verdicts.filter((v) => !v).length },
        }
    })
    return <Reviews reviews={reviews} />
}
