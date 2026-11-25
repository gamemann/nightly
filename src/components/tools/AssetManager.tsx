'use client'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { RecentUploads, UploadPanel } from './UploadPanel'

/** The Asset Manager: upload (all asset types, validated) above the asset browser (`children`, the existing list with search, filters, thumbnails and the audit). */
export function AssetManager({ projectSlug, children }: { projectSlug?: string; children?: ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <div>
            <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-3 px-6 pt-5 max-md:px-3">
                <h1 className="text-[15px] font-semibold tracking-tight">Asset Manager{projectSlug ? <span className="ml-2 text-[12px] font-normal text-muted">{projectSlug}</span> : null}</h1>
                <div className="flex gap-2"><Link className="btn" href="/tools/assets/coverage">Coverage</Link><Link className="btn" href="/tools/assets/sources">Sources</Link><button className="btn-primary btn" onClick={() => setOpen(!open)}>{open ? 'Hide upload' : 'Upload assets'}</button></div>
            </div>
            {open && <div className="mx-auto mt-3 max-w-6xl px-6 max-md:px-3"><UploadPanel projectSlug={projectSlug} /><RecentUploads /></div>}
            {children}
        </div>
    )
}
