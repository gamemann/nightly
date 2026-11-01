"use client"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { ModelViewer } from "./ModelViewer"
import { ago } from "./pills"

/** One attachment picture, with the model beside it when there is one (see src/server/models.ts). */
export type Shot = { item: string; file: string; note: string; at: string; model: string | null }
export type Pin = { id: number; kind: string; target: string; x: number; y: number; z: number; nx: number; ny: number; nz: number; text: string; author: string; createdAt: string }

const url = (item: string, file: string) => `/attachments/${encodeURIComponent(item)}/${encodeURIComponent(file)}`

function usePins(item: string, target: string) {
    const [pins, setPins] = useState<Pin[]>([])
    const load = useCallback(async () => {
        const r = await fetch(`/api/annotations?item=${encodeURIComponent(item)}&target=${encodeURIComponent(target)}`)
        if (r.ok) setPins(await r.json())
    }, [item, target])
    useEffect(() => { setPins([]); void load() }, [load])
    const add = async (kind: "model" | "image", pos: Partial<Pin>) => {
        const text = window.prompt("Note for this point")?.trim()
        if (!text) return
        await fetch("/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item, target, kind, text, ...pos }) })
        await load()
    }
    const del = async (id: number) => {
        if (!confirm("Delete this pin?")) return
        await fetch(`/api/annotations?id=${id}`, { method: "DELETE" })
        await load()
    }
    return { pins, add, del }
}

/** Full-screen view of a picture; with a sibling model, a 3D tab to orbit it. Clicking places a pin with a note. */
export function PictureViewer({ shot, onClose }: { shot: Shot; onClose: () => void }) {
    const [mode, setMode] = useState<"3d" | "picture">(shot.model ? "3d" : "picture")
    const [sel, setSel] = useState<number | null>(null)
    const target = mode === "3d" && shot.model ? shot.model : shot.file
    const { pins, add, del } = usePins(shot.item, target)
    useEffect(() => {
        const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
        window.addEventListener("keydown", key)
        return () => window.removeEventListener("keydown", key)
    }, [onClose])
    const btn = "rounded border border-white/20 px-3 py-1.5 text-[13px]"
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/90 p-3 text-white" role="dialog" aria-label="picture viewer">
            <div className="mx-auto max-w-[1600px] rounded-lg p-3" style={{ background: "#111" }}>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                    <Link href={`/item/${encodeURIComponent(shot.item)}`} className="font-mono text-white/70 hover:text-white">{shot.item}</Link>
                    <span className="min-w-0 flex-1 truncate">{shot.note || shot.file}</span>
                    {shot.model && (
                        <>
                            <button className={`${btn} ${mode === "3d" ? "bg-white/15" : ""}`} onClick={() => setMode("3d")}>3D</button>
                            <button className={`${btn} ${mode === "picture" ? "bg-white/15" : ""}`} onClick={() => setMode("picture")}>Picture</button>
                        </>
                    )}
                    <button className={btn} onClick={onClose}>Close (Esc)</button>
                </div>
                <div className="flex gap-3 max-md:flex-col">
                    <div className="h-[75vh] min-w-0 flex-1 max-md:h-[55vh]">
                        {mode === "3d" && shot.model
                            ? <ModelViewer url={url(shot.item, shot.model)} pins={pins} selected={sel} onSelect={setSel} onPlace={(h) => void add("model", h)} />
                            : <FlatPicture src={url(shot.item, shot.file)} pins={pins} selected={sel} onSelect={setSel} onPlace={(x, y) => void add("image", { x, y })} />}
                    </div>
                    <aside className="w-72 shrink-0 space-y-2 overflow-y-auto text-[13px] max-md:w-full">
                        <div className="text-white/60">Notes · {pins.length}</div>
                        {pins.length === 0 && <div className="text-white/40">Click {mode === "3d" ? "the model" : "the picture"} to pin a note.</div>}
                        {pins.map((p, i) => (
                            <div key={p.id} onClick={() => setSel(p.id)} className={`cursor-pointer rounded border px-2 py-1.5 ${sel === p.id ? "border-amber-400" : "border-white/15"}`}>
                                <div className="flex items-center gap-2 text-[11px] text-white/50">
                                    <span className="grid size-5 place-items-center rounded-full bg-[#8b8cf8] text-white">{i + 1}</span>
                                    {p.author} · {ago(p.createdAt)}
                                    <button onClick={(e) => { e.stopPropagation(); void del(p.id) }} className="ml-auto hover:text-red-400">delete</button>
                                </div>
                                <div className="mt-1 whitespace-pre-wrap">{p.text}</div>
                            </div>
                        ))}
                    </aside>
                </div>
            </div>
        </div>
    )
}

function FlatPicture({ src, pins, selected, onSelect, onPlace }: { src: string; pins: Pin[]; selected: number | null; onSelect: (id: number) => void; onPlace: (x: number, y: number) => void }) {
    return (
        <div className="grid h-full place-items-center overflow-auto">
            <div className="relative inline-block max-h-full max-w-full cursor-crosshair"
                onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    onPlace((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
                }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" draggable={false} className="block max-h-[75vh] max-w-full rounded" />
                {pins.map((p, i) => (
                    <button key={p.id} title={p.text} onClick={(e) => { e.stopPropagation(); onSelect(p.id) }}
                        className={`absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-[11px] text-white ${selected === p.id ? "bg-amber-500" : "bg-[#8b8cf8]"}`}
                        style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>{i + 1}</button>
                ))}
            </div>
        </div>
    )
}
