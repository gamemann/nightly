'use client'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { RecentUploads, UploadPanel } from './UploadPanel'

/** The Map Manager: map upload (GameSpice map json + bin, BSP, VMF, Quake .map, glb, obj) above the map list (`children`); a row opens the 3D fly-cam viewer. */
export function MapManager({ projectSlug, children }: { projectSlug?: string; children?: ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <div>
            <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-3 px-6 pt-5 max-md:px-3">
                <h1 className="text-[15px] font-semibold tracking-tight">Map Manager{projectSlug ? <span className="ml-2 text-[12px] font-normal text-muted">{projectSlug}</span> : null}</h1>
                <div className="flex gap-2"><Link className="btn" href="/tools/map-converter">Convert a map</Link><button className="btn-primary btn" onClick={() => setOpen(!open)}>{open ? 'Hide upload' : 'Upload map'}</button></div>
            </div>
            {open && <div className="mx-auto mt-3 max-w-6xl px-6 max-md:px-3"><UploadPanel projectSlug={projectSlug} fixedType="map" title="Upload a map (a GameSpice .json needs its .bin too: drop both)" /><RecentUploads type="map" /></div>}
            {children}
        </div>
    )
}
