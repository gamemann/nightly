import Link from 'next/link'
import type { Coverage } from '~/server/assetsCoverage'
import { DIMS, STATUSES } from '../../lib/asset-coverage.mjs'

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const STATUS_CLS: Record<string, string> = { ok: 'text-emerald-300', placeholder: 'text-amber-300', stale: 'text-red-300', missing: 'text-red-300', na: 'text-muted' }
const th = 'px-2 py-1 text-right font-medium text-muted'
const td = 'px-2 py-1 text-right tabular-nums'

/** Asset coverage: per pack and kind, how many assets lack a needed model / texture / sound / anim / icon / licence (needed = the kind's `needs`). Data only: `nightly assets coverage` fills it. */
export function AssetCoverage({ data }: { data: Coverage }) {
    const t = data.totals
    return (
        <div className="mx-auto max-w-6xl px-6 py-4 text-[12px] max-md:px-3">
            <p className="text-muted">
                {t.rows} assets, <b className="text-fg">{t.complete}</b> complete ({pct(t.complete, t.rows)}%), {t.orphan} orphaned{data.uncomputed ? `, ${data.uncomputed} not computed yet (run nightly assets coverage)` : ''}.
                {' '}A gap is a dimension the asset&apos;s kind needs that is not ok: missing, stale (the link points at nothing) or placeholder (flat colour, synth-only sound, static clips).
            </p>
            <table className="mt-3 w-full border-collapse">
                <thead><tr className="border-b border-line"><th className="px-2 py-1 text-left font-medium text-muted">dimension</th>{STATUSES.map((s) => <th key={s} className={th}>{s}</th>)}</tr></thead>
                <tbody>{DIMS.map((d) => <tr key={d} className="border-b border-line/50"><td className="px-2 py-1">{d}</td>{STATUSES.map((s) => <td key={s} className={`${td} ${t.dims[d][s] ? STATUS_CLS[s] : 'text-muted'}`}>{t.dims[d][s]}</td>)}</tr>)}</tbody>
            </table>
            <table className="mt-5 w-full border-collapse">
                <thead><tr className="border-b border-line"><th className="px-2 py-1 text-left font-medium text-muted">pack / kind</th><th className={th}>assets</th><th className={th}>complete</th>{DIMS.map((d) => <th key={d} className={th}>{d}</th>)}<th className="px-2 py-1 text-left font-medium text-muted">needs</th></tr></thead>
                <tbody>
                    {data.packs.map((p) => [
                        <tr key={p.pack} className="border-b border-line bg-panel">
                            <td className="px-2 py-1 font-medium"><Link href={`/tools/assets?pack=${encodeURIComponent(p.pack)}`}>{p.pack}</Link>{p.orphan ? <span className="ml-2 text-red-300">{p.orphan}</span> : null}</td>
                            <td className={td}>{p.rows}</td><td className={`${td} ${p.complete === p.rows ? 'text-emerald-300' : ''}`}>{pct(p.complete, p.rows)}%</td>
                            {DIMS.map((d) => { const n = p.kinds.reduce((a, k) => a + k.gaps[d], 0); return <td key={d} className={`${td} ${n ? 'text-red-300' : 'text-muted'}`}>{n || '.'}</td> })}<td />
                        </tr>,
                        ...p.kinds.map((k) => (
                            <tr key={`${p.pack}/${k.kind}`} className="border-b border-line/50">
                                <td className="px-2 py-1 pl-6"><Link className="text-muted hover:text-fg" href={`/tools/assets?pack=${encodeURIComponent(p.pack)}&kind=${encodeURIComponent(k.kind)}`}>{k.kind}</Link></td>
                                <td className={td}>{k.rows}</td><td className={td}>{pct(k.complete, k.rows)}%</td>
                                {DIMS.map((d) => <td key={d} title={STATUSES.map((s) => `${s} ${k.dims[d][s]}`).join(', ')} className={`${td} ${k.gaps[d] ? (k.dims[d].missing || k.dims[d].stale ? 'text-red-300' : 'text-amber-300') : 'text-muted'}`}>{k.gaps[d] || '.'}</td>)}
                                <td className="px-2 py-1 text-muted">{(data.needs[k.kind] ?? ['model', 'licence']).join(' ')}</td>
                            </tr>
                        )),
                    ])}
                </tbody>
            </table>
            {data.empty.length ? <p className="mt-4 text-muted">Sources with no assets: {data.empty.map((s) => `${s.name}${s.enabled ? '' : ' (off)'}${s.rootOk ? '' : ' (root missing)'}`).join(', ')}</p> : null}
        </div>
    )
}
