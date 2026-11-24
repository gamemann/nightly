"use client"
import { adsWeaponPos, sightFov, sightMagnification, type Sight } from "./sightLine"
import { useEffect, useRef, useState } from "react"
import type * as T from "three"
import type { Mounted } from "./AssetViewer"
import { syncMounts } from "./mountSync"
import { lens, sample, verticalFrom43 } from "../../lib/anim-sample.mjs"

type Track = { target: string; path: string; values: number[] }
type Clip = { name: string; length: number; frames: number; loop: boolean; tracks: Track[] }
type Side = { fps: number; lens: { viewmodel_fov_h: number; world_fov_h: number; reference_depth: number; max_pull_in: number; depth_comp: number }; nodes: { bolt: string; magazine: string }; clips: Clip[] }
type Ctl = { clip: number; t: number; playing: boolean; speed: number; fov: number; loop: boolean }

/** First-person "view model" mode: the camera sits at the eye, the weapon and the support hands are posed from the baked clips (the game's own
 *  AwViewModel sampled at 60 fps), and the viewmodel FoV slider re-applies the game's lens (GSViewLens) so the gun reads as it does in play.
 *  Play / pause / scrub / speed drive the clip; `loop` repeats a one-shot clip. */
export function AssetViewModel({ glbUrl, animUrl, initialClip, mounted, sight }: { glbUrl: string; animUrl: string; initialClip?: string; mounted?: Mounted[]; sight?: Sight | null }) {
    const box = useRef<HTMLDivElement>(null)
    const [side, setSide] = useState<Side | null>(null)
    const [err, setErr] = useState("")
    const [shownT, setShownT] = useState(0)
    const [c, setC] = useState<Ctl>({ clip: 0, t: 0, playing: true, speed: 1, fov: 54, loop: true })
    const ctl = useRef(c)
    const mountApi = useRef<(l: Mounted[]) => void>(() => {})
    const mountList = useRef<Mounted[]>(mounted ?? [])
    mountList.current = mounted ?? []
    useEffect(() => { mountApi.current(mounted ?? []) }, [mounted])
    ctl.current = c
    const [sightOn, setSightOn] = useState(false)
    const sightRef = useRef<Sight | null>(null)
    sightRef.current = sightOn ? sight ?? null : null
    useEffect(() => {
        void fetch(animUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`anim ${r.status}`)))).then((s: Side) => {
            setSide(s)
            const i = initialClip ? s.clips.findIndex((k) => k.name === initialClip) : 0
            setC((p) => ({ ...p, clip: Math.max(0, i), fov: s.lens.viewmodel_fov_h }))
        }).catch((e: Error) => setErr(e.message))
    }, [animUrl, initialClip])
    const ready = side !== null
    useEffect(() => {
        if (!side) return
        let dead = false
        let cleanup = () => {}
        void (async () => {
            const THREE = await import("three")
            const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
            if (dead || !box.current) return
            const el = box.current
            const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
            el.appendChild(renderer.domElement)
            const scene = new THREE.Scene()
            scene.background = new THREE.Color(0x24262c)
            scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.6))
            const sun = new THREE.DirectionalLight(0xffffff, 2.2)
            sun.position.set(1, 2, 1)
            scene.add(sun)
            const floor = new THREE.GridHelper(20, 40, 0x555a66, 0x30333b)
            floor.position.y = -1.5
            scene.add(floor)
            const worldV = verticalFrom43(side.lens.world_fov_h)
            const camera = new THREE.PerspectiveCamera(worldV, 1, 0.01, 200)
            const punch = new THREE.Group()
            punch.add(camera)
            scene.add(punch)
            // rig: the lens (scale k,k,1 and the z push) carrying the weapon, which the clip poses in the camera's frame
            const rig = new THREE.Group()
            camera.add(rig)
            const weapon = new THREE.Group()
            rig.add(weapon)
            const skin = new THREE.MeshStandardMaterial({ color: 0xd8a47f, roughness: 0.7 })
            const hands: Record<string, T.Mesh> = {}
            const arms: Record<string, T.Mesh> = {}
            for (const k of ["right", "left"]) {
                hands[k] = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), skin)
                arms[k] = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1, 12), skin)
                rig.add(hands[k], arms[k])
            }
            const cache = new Map<string, Promise<T.Object3D>>()
            const loadAtt = (u: string) => { let p = cache.get(u); if (!p) { p = new GLTFLoader().loadAsync(u).then((g) => g.scene); cache.set(u, p) } return p }
            mountApi.current = (l) => syncMounts(THREE, loadAtt, weapon, l, () => dead)
            let bolt: T.Object3D | null = null
            let boltHome = new THREE.Vector3()
            new GLTFLoader().load(glbUrl, (g) => {
                if (dead) return
                weapon.add(g.scene)
                mountApi.current(mountList.current)
                if (side.nodes.bolt) { bolt = g.scene.getObjectByName(side.nodes.bolt) ?? null; if (bolt) boltHome = bolt.position.clone() }
            }, undefined, (e) => setErr(`model: ${String((e as Error).message ?? e)}`))
            const resize = () => {
                const w = el.clientWidth, h = Math.max(240, Math.round(w * 0.5625))
                renderer.setSize(w, h)
                camera.aspect = w / h
                camera.updateProjectionMatrix()
            }
            resize()
            const ro = new ResizeObserver(resize)
            ro.observe(el)
            const limb = (m: T.Mesh, a: T.Vector3, b: T.Vector3) => {
                const d = b.clone().sub(a)
                m.position.copy(a.clone().add(b).multiplyScalar(0.5))
                m.scale.set(1, Math.max(d.length(), 1e-4), 1)
                m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())
            }
            let last = performance.now()
            let raf = 0
            const tick = (now: number) => {
                raf = requestAnimationFrame(tick)
                const k = ctl.current
                const clip = side.clips[k.clip]
                const dt = Math.min((now - last) / 1000, 0.1)
                last = now
                if (!clip) return
                if (k.playing) {
                    let t = k.t + dt * k.speed
                    if (t >= clip.length) t = k.loop || clip.loop ? t % clip.length : clip.length - 1 / side.fps
                    ctl.current = { ...k, t }
                    setShownT(t)
                }
                const t = ctl.current.t
                const get = (name: string) => { const tr = clip.tracks.find((x) => x.target === name); return tr ? sample(tr, t, clip.frames, side.fps, clip.loop) : null }
                const sg = sightRef.current
                const L = lens(side.lens, worldV, verticalFrom43(ctl.current.fov))
                const fovNow = sg ? sightFov(sg) : worldV
                if (camera.fov !== fovNow) { camera.fov = fovNow; camera.updateProjectionMatrix() }
                // sight line: the weapon is held so the optic sits on the eye's axis (sightLine.ts), unscaled by the lens; off, the clip poses it
                rig.scale.set(sg ? 1 : L.k, sg ? 1 : L.k, 1)
                rig.position.set(0, 0, sg ? 0 : L.z)
                const w = get("weapon")
                if (sg) { const q = adsWeaponPos(sg); weapon.position.set(q[0], q[1], q[2]); weapon.quaternion.set(0, 0, 0, 1) }
                else if (w) { weapon.position.set(w[0], w[1], w[2]); weapon.quaternion.set(w[3], w[4], w[5], w[6]) }
                const b = get("bolt")
                if (bolt) { if (b) bolt.position.set(b[0], b[1], b[2]); else bolt.position.copy(boltHome) }
                const p = get("view_punch")
                punch.rotation.set(p ? (p[0] * Math.PI) / 180 : 0, p ? (p[1] * Math.PI) / 180 : 0, 0)
                for (const key of ["right", "left"]) {
                    const h = get(`hand.${key}`), s = get(`hand.${key}_shoulder`)
                    if (h && s) { hands[key].position.set(h[0], h[1], h[2]); limb(arms[key], new THREE.Vector3(s[0], s[1], s[2]), new THREE.Vector3(h[0], h[1], h[2])) }
                }
                renderer.render(scene, camera)
            }
            raf = requestAnimationFrame(tick)
            cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); renderer.domElement.remove() }
        })()
        return () => { dead = true; cleanup() }
    }, [side, glbUrl])
    const clip = side?.clips[c.clip]
    if (err) return <div className="rounded-lg border border-line p-6 text-center text-[12px] text-muted" data-testid="vm-error">View model unavailable: {err}</div>
    if (!ready || !side || !clip) return <div className="rounded-lg border border-line p-6 text-center text-[12px] text-muted">Loading animations...</div>
    const set = (p: Partial<Ctl>) => setC((x) => { const n = { ...x, ...p }; ctl.current = n; return n })
    return (
        <div data-testid="vm-pane">
            <div ref={box} className="w-full overflow-hidden rounded-lg border border-line" data-testid="vm-canvas" />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
                <select value={c.clip} onChange={(e) => { setShownT(0); set({ clip: Number(e.target.value), t: 0 }) }} data-testid="vm-clip" className="rounded border border-line bg-transparent px-1 py-0.5">
                    {side.clips.map((k, i) => <option key={k.name} value={i}>{k.name}</option>)}
                </select>
                <button onClick={() => set({ playing: !c.playing })} data-testid="vm-play" className="rounded border border-line px-2 py-0.5">{c.playing ? "Pause" : "Play"}</button>
                <input type="range" min={0} max={clip.length} step={1 / side.fps} value={Math.min(shownT, clip.length)} onChange={(e) => { setShownT(Number(e.target.value)); set({ t: Number(e.target.value), playing: false }) }} data-testid="vm-scrub" className="min-w-40 flex-1" />
                <span className="tabular-nums text-muted">{shownT.toFixed(2)} / {clip.length.toFixed(2)} s</span>
                <label>Speed <select value={c.speed} onChange={(e) => set({ speed: Number(e.target.value) })} data-testid="vm-speed" className="rounded border border-line bg-transparent px-1 py-0.5">{[0.1, 0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}x</option>)}</select></label>
                <label><input type="checkbox" checked={c.loop} onChange={(e) => set({ loop: e.target.checked })} /> Loop</label>
                <label>Viewmodel FoV {c.fov}<input type="range" min={50} max={100} step={1} value={c.fov} onChange={(e) => set({ fov: Number(e.target.value) })} data-testid="vm-fov" className="ml-2 align-middle" /></label>
                {sight && <button onClick={() => setSightOn(!sightOn)} data-testid="vm-sight-toggle" title={`${sight.label}, aim ${sight.aim}`} className={`rounded border px-2 py-0.5 ${sightOn ? "border-sky-300 text-sky-300" : "border-line"}`}>{sightOn ? `Sight ${sightMagnification(sight)}` : "Hip"}</button>}
                <button onClick={() => set({ fov: side.lens.viewmodel_fov_h })} className="rounded border border-line px-2 py-0.5">Default ({side.lens.viewmodel_fov_h})</button>
            </div>
        </div>
    )
}
