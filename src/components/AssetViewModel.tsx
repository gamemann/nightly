"use client"
import { adsWeaponPos, sightFov, sightMagnification, type Sight } from "./sightLine"
import { useEffect, useRef, useState } from "react"
import type * as T from "three"
import type { Mounted } from "./AssetViewer"
import { syncMounts } from "./mountSync"
import { AV, buildViewArms, recolour, texture, type Book, type ViewArms } from "./avatarKit"
import { lens, moveShare, sample, verticalFrom43 } from "../../lib/anim-sample.mjs"

type Track = { target: string; path: string; values: number[] }
type Shape = { kind: "box" | "cylinder" | "sphere"; size: number[]; at: number[]; colour?: string; metal?: number; rough?: number; glow?: string }
type Clip = { name: string; length: number; frames: number; loop: boolean; tracks: Track[]; props?: Record<string, { part: string; shapes: Shape[] }> }
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
            // stand-ins until the game's arms (the people figure, IK'd to the wrist targets) have loaded
            for (const k of ["right", "left"]) {
                hands[k] = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), skin)
                rig.add(hands[k])
            }
            let viewArms: ViewArms | null = null
            void fetch(`${AV}avatars.json`).then((r) => r.json()).then(async (book: Book) => {
                const av = book.avatars[0]
                if (!av) return
                const [g, cv] = await Promise.all([
                    new GLTFLoader().loadAsync(`${AV}${av.glb}`),
                    book.atlas ? recolour(`${AV}${book.atlas}`, av.swaps ?? []).catch(() => null) : Promise.resolve(null),
                ])
                if (dead) return
                if (cv) texture(THREE, g.scene, cv)
                viewArms = buildViewArms(THREE, g.scene, av, rig)
                for (const k of Object.keys(hands)) hands[k].visible = false
            }).catch(() => {})
            const cache = new Map<string, Promise<T.Object3D>>()
            const loadAtt = (u: string) => { let p = cache.get(u); if (!p) { p = new GLTFLoader().loadAsync(u).then((g) => g.scene); cache.set(u, p) } return p }
            mountApi.current = (l) => syncMounts(THREE, loadAtt, weapon, l, () => dead)
            // reload props (ammo box, casing ...): the game builds them in code, the sidecar carries their primitives and the per-frame transform / scale / visibility
            const propNodes = new Map<string, T.Group>()
            const propOf = (ci: number, key: string, spec: { shapes: Shape[] }) => {
                const id = `${ci}:${key}`
                let grp = propNodes.get(id)
                if (grp) return grp
                grp = new THREE.Group()
                for (const sh of spec.shapes) {
                    const [a, b, c] = sh.size
                    const geo = sh.kind === "box" ? new THREE.BoxGeometry(a, b, c) : sh.kind === "cylinder" ? new THREE.CylinderGeometry(a, b, c, 16) : new THREE.SphereGeometry(a, 16, 12)
                    const m = new THREE.MeshStandardMaterial({ color: sh.colour ?? "#888888", metalness: sh.metal ?? 0, roughness: sh.rough ?? 0.6 })
                    if (sh.glow) { m.emissive = new THREE.Color(sh.glow) }
                    const mesh = new THREE.Mesh(geo, m)
                    const e = sh.at
                    mesh.matrixAutoUpdate = false
                    // Godot basis columns x y z + origin (right-handed, Y up, same as three)
                    mesh.matrix.set(e[0], e[3], e[6], e[9], e[1], e[4], e[7], e[10], e[2], e[5], e[8], e[11], 0, 0, 0, 1)
                    grp.add(mesh)
                }
                grp.visible = false
                rig.add(grp)
                propNodes.set(id, grp)
                return grp
            }
            let bolt: T.Object3D | null = null
            let boltHome = new THREE.Vector3()
            new GLTFLoader().load(glbUrl, (g) => {
                if (dead) return
                weapon.add(g.scene)
                mountApi.current(mountList.current)
                if (side.nodes.bolt) { bolt = g.scene.getObjectByName(side.nodes.bolt) ?? null; if (bolt) boltHome = bolt.position.clone() }
            }, undefined, (e) => setErr(`model: ${String((e as Error).message ?? e)}`))
            const idle = side.clips.find((k) => k.name === "idle") ?? side.clips[0]
            const rest = idle?.tracks.find((x) => x.target === "weapon")?.values.slice(0, 3) ?? null
            const resize = () => {
                const w = el.clientWidth, h = Math.max(240, Math.round(w * 0.5625))
                renderer.setSize(w, h)
                camera.aspect = w / h
                camera.updateProjectionMatrix()
            }
            resize()
            const ro = new ResizeObserver(resize)
            ro.observe(el)
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
                // lens_move_share: the pose's sideways / upward moves (off the idle pose) shrink as the game's AwWeaponPose does
                const share = moveShare(side.lens, verticalFrom43(ctl.current.fov))
                if (w && rest) { w[0] = rest[0] + (w[0] - rest[0]) * share; w[1] = rest[1] + (w[1] - rest[1]) * share }
                if (sg) { const q = adsWeaponPos(sg); weapon.position.set(q[0], q[1], q[2]); weapon.quaternion.set(0, 0, 0, 1) }
                else if (w) { weapon.position.set(w[0], w[1], w[2]); weapon.quaternion.set(w[3], w[4], w[5], w[6]) }
                const b = get("bolt")
                if (bolt) { if (b) bolt.position.set(b[0], b[1], b[2]); else bolt.position.copy(boltHome) }
                // AwWeaponPose.view_punch: x pitch up, y yaw, degrees; games add them to the camera pitch / yaw (rotation.x / .y, Godot and three share the right-handed Y-up Euler)
                const p = get("view_punch")
                punch.rotation.set(p ? (p[0] * Math.PI) / 180 : 0, p ? (p[1] * Math.PI) / 180 : 0, 0)
                for (const grp of propNodes.values()) grp.visible = false
                for (const [key, spec] of Object.entries(clip.props ?? {})) {
                    const tf = get(`prop.${key}`), sc = get(`prop.${key}.scale`), vis = get(`prop.${key}.visible`)
                    if (!tf) continue
                    const grp = propOf(ctl.current.clip, key, spec)
                    grp.position.set(tf[0], tf[1], tf[2])
                    grp.quaternion.set(tf[3], tf[4], tf[5], tf[6])
                    if (sc) grp.scale.set(sc[0], sc[1], sc[2])
                    grp.visible = !vis || vis[0] > 0.5
                }
                const wrist = (key: string) => { const h = get(`hand.${key}`); return h ? new THREE.Vector3(h[0], h[1], h[2]) : null }
                const R = wrist("right"), Lh = wrist("left")
                for (const [key, v] of [["right", R], ["left", Lh]] as const) if (v) hands[key].position.copy(v)
                viewArms?.solve(R, Lh)
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
