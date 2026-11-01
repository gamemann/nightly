import { GamePage } from '~/components/Game'

export default async function GameSlugPage({ params }: { params: Promise<{ slug: string }> }) {
    const slug = decodeURIComponent((await params).slug)
    return <GamePage key={slug} slug={slug} />
}
