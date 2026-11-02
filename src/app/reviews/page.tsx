import { Reviews } from "~/components/Reviews"
import { db } from "~/server/db"
import { classify } from "../../../lib/classify.mjs"
import { load } from "../../../lib/review.mjs"

export const dynamic = "force-dynamic"

export default async function ReviewsPage() {
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
