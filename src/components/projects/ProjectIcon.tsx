/* eslint-disable @next/next/no-img-element */
const TYPE_GLYPH: Record<string, string> = { game: '◆', 'game-addon': '◇', website: '◎' }

/** A project's uploaded icon, or its type glyph on a tinted tile. */
export function ProjectIcon({ p, size = 'size-9' }: { p: { slug: string; type: string; icon?: string | null }; size?: string }) {
    if (p.icon) return <img src={`/api/projects/${encodeURIComponent(p.slug)}/icon?v=${encodeURIComponent(p.icon)}`} alt="" className={`${size} shrink-0 rounded-lg object-cover ring-1 ring-line`} />
    return <span className={`${size} grid shrink-0 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/20`}>{TYPE_GLYPH[p.type] ?? '▤'}</span>
}
