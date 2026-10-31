import { Reviews } from "~/components/Reviews"
import { db } from "~/server/db"
import { load } from "../../../lib/review.mjs"

export const dynamic = "force-dynamic"

export default async function ReviewsPage() {
    const items = await db.item.findMany({ where: { kind: "review" }, orderBy: { id: "desc" }, take: 100 })
    const reviews = items.map((i) => ({ key: i.key, title: i.title, body: i.body, createdAt: i.createdAt.toISOString(), weapons: load(i.key).weapons }))
    return <Reviews reviews={reviews} />
}
