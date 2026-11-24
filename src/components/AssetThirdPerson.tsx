"use client"
import { sightMagnification, sightPose, type Sight } from "./sightLine"
import { useEffect, useRef, useState } from "react"
import type * as T from "three"
import { sample } from "../../lib/anim-sample.mjs"
import type { Mounted } from "./AssetViewer"
import { syncMounts } from "./mountSync"
import { AV, plain, recolour, texture, type Avatar, type Book } from "./avatarKit"

type Track = { target: string; path: string; values: number[] }
type Clip = { name: string; length: number; frames: number; loop: boolean; tracks: Track[] }
type Side = { fps: number; third_person?: { pose: string; rest: number[] }; nodes: { bolt: string; magazine: string }; clips: Clip[] }
type Ctl = { clip: number; t: number; playing: boolean; speed: number; loop: boolean }


/** Third-person mode: an avatar (the game's own people_<body>.glb, bones posed as the game poses them) holds the weapon at its hand bone with the
 *  game's grip (mount x weapon rest); the baked bolt / magazine tracks animate the weapon; the camera orbits the figure (drag, wheel). */
export function AssetThirdPerson({ glbUrl, animUrl, mounted, sight }: { glbUrl: string; animUrl: string; mounted?: Mounted[]; sight?: Sight | null }) {
    const box = useRef<HTMLDivElement>(null)
    const [side, setSide] = useState<Side | null>(null)
    const [book, setBook] = useState<Book | null>(null)
    const [who, setWho] = useState(0)
    const [err, setErr] = useState("")
    const [shownT, setShownT] = useState(0)
    const [c, setC] = useState<Ctl>({ clip: 0, t: 0, playing: true, speed: 1, loop: true })
    const ctl = useRef(c)
    ctl.current = c
    const [sightOn, setSightOn] = useState(false)
    const sightRef = useRef<Sight | null>(null)
    sightRef.current = sightOn ? sight ?? null : null
    const mountApi = useRef<(l: Mounted[]) => void>(() => {})
    const mountList = useRef<Mounted[]>(mounted ?? [])
    mountList.current = mounted ?? []
    useEffect(() => { mountApi.current(mounted ?? []) }, [mounted])
    useEffect(() => {
        const j = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`))))
        void Promise.all([j(animUrl), j(`${AV}avatars.json`)]).then(([s, b]: [Side, Book]) => {
            if (!s.third_person) throw new Error("this bake has no third-person grip; re-run the exporter")
            setSide(s); setBook(b)
        }).catch((e: Error) => setErr(e.message))
    }, [animUrl])
    useEffect(() => {
        if (!side || !book || !side.third_person) return
        const av = book.avatars[who]
        const rest = side.third_person.rest
        let dead = false
        let cleanup = () => {}
        void (async () => {
            const THREE = await import("three")
            const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
            const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js")
            if (dead || !box.current || !av) return
            const el = box.current
            const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
            el.appendChild(renderer.domElement)
            const scene = new THREE.Scene()
            scene.background = new THREE.Color(0x24262c)
            scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.6))
            const sun = new THREE.DirectionalLight(0xffffff, 2.2)
            sun.position.set(2, 3, 2)
            scene.add(sun)
            scene.add(new THREE.GridHelper(6, 24, 0x555a66, 0x30333b))
            const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100)
            camera.position.set(1.6, 1.3, 2.4)
            const orbit = new OrbitControls(camera, renderer.domElement)
            orbit.target.set(0, 1.0, 0)
            orbit.update()
            let hh = 1.8
            const mat = (a: number[], o = 0) => new THREE.Matrix4().makeBasis(new THREE.Vector3(a[o], a[o + 1], a[o + 2]), new THREE.Vector3(a[o + 3], a[o + 4], a[o + 5]), new THREE.Vector3(a[o + 6], a[o + 7], a[o + 8])).setPosition(a[o + 9], a[o + 10], a[o + 11])
            const cache = new Map<string, Promise<T.Object3D>>()
            const loadAtt = (u: string) => { let p = cache.get(u); if (!p) { p = new GLTFLoader().loadAsync(u).then((g) => g.scene); cache.set(u, p) } return p }
            const held = new THREE.Group()
            held.matrixAutoUpdate = false
            scene.add(held)
            let bolt: T.Object3D | null = null
            let mag: T.Object3D | null = null
            let boltHome = new THREE.Vector3(), magHome = new THREE.Vector3()
            let handBone: T.Object3D | null = null
            const bones = new Map<string, T.Object3D>()
            const holdWeapon = (g: T.Object3D) => {
                held.add(g)
                mountApi.current = (l) => syncMounts(THREE, loadAtt, g, l, () => dead)
                mountApi.current(mountList.current)
                if (side.nodes.bolt) { bolt = g.getObjectByName(side.nodes.bolt) ?? null; if (bolt) boltHome = bolt.position.clone() }
                if (side.nodes.magazine) { mag = g.getObjectByName(side.nodes.magazine) ?? null; if (mag) magHome = mag.position.clone() }
            }
            const place = () => {
                if (!handBone) return
                handBone.updateWorldMatrix(true, false)
                held.matrix.copy(handBone.matrixWorld).multiply(mat(av.mount)).multiply(mat(rest))
                held.matrixWorldNeedsUpdate = true
            }
            const atlasTex = book.atlas ? recolour(`${AV}${book.atlas}`, av.swaps ?? []).catch(() => null) : Promise.resolve(null)
            new GLTFLoader().load(`${AV}${av.glb}`, (g) => {
                if (dead) return
                const root = g.scene
                scene.add(root)
                void atlasTex.then((cv) => {
                    if (!cv || dead) return
                    texture(THREE, root, cv)
                })
                root.traverse((n) => { if ((n as T.Bone).isBone) bones.set(plain(n.name), n) })
                for (const [name, v] of Object.entries(av.bones)) {
                    const b = bones.get(plain(name))
                    if (!b || v.length < 10) continue
                    b.position.set(v[0], v[1], v[2]); b.quaternion.set(v[3], v[4], v[5], v[6]); b.scale.set(v[7], v[8], v[9])
                }
                handBone = bones.get(plain(book.hand_bone)) ?? null
                // land the skeleton node where the game's figure has it (skeleton_in_figure), then the figure sits on the floor
                root.updateMatrixWorld(true)
                const skel = handBone ? ((): T.Object3D => { let n: T.Object3D = handBone; while (n.parent && (n.parent as T.Bone).isBone) n = n.parent; return n.parent ?? n })() : root
                const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(skel.matrixWorld)
                root.matrixAutoUpdate = false
                root.matrix.copy(mat(av.skeleton_in_figure)).multiply(rel.invert())
                root.updateMatrixWorld(true)
                hh = book.height || 1.8
                orbit.target.set(0, hh * 0.5, 0); camera.position.set(hh * 0.8, hh * 0.7, hh * 1.5); orbit.update()
                place()
                void loadAtt(glbUrl).then((w) => { if (!dead) holdWeapon(w.clone(true)) }, (e) => setErr(`weapon: ${String((e as Error).message ?? e)}`))
            }, undefined, (e) => setErr(`avatar: ${String((e as Error).message ?? e)}`))
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
            let sightWas = false
            let raf = 0
            const tick = (now: number) => {
                raf = requestAnimationFrame(tick)
                const k = ctl.current
                const clip = side.clips[k.clip]
                const dt = Math.min((now - last) / 1000, 0.1)
                last = now
                if (clip) {
                    if (k.playing) {
                        let t = k.t + dt * k.speed
                        if (t >= clip.length) t = k.loop || clip.loop ? t % clip.length : clip.length - 1 / side.fps
                        ctl.current = { ...k, t }
                        setShownT(t)
                    }
                    const t = ctl.current.t
                    const get = (name: string) => { const tr = clip.tracks.find((x) => x.target === name); return tr ? sample(tr, t, clip.frames, side.fps, clip.loop) : null }
                    const b = get("bolt")
                    if (bolt) { if (b) bolt.position.set(b[0], b[1], b[2]); else bolt.position.copy(boltHome) }
                    if (mag) {
                        const m = get("magazine"), v = get("magazine.visible")
                        if (m) mag.position.set(m[0], m[1], m[2]); else mag.position.copy(magHome)
                        mag.visible = v ? v[0] > 0.5 : true
                    }
                }
                const sg = sightRef.current
                if (sg) {
                    // sight line: the camera rides behind the optic on the held weapon and looks down its bore (pose from sightLine.ts)
                    const pose = sightPose(sg)
                    held.updateMatrixWorld(true)
                    camera.position.copy(held.localToWorld(new THREE.Vector3(...pose.position)))
                    camera.up.set(0, 1, 0)
                    camera.lookAt(held.localToWorld(new THREE.Vector3(...pose.target)))
                    if (camera.fov !== pose.fov) { camera.fov = pose.fov; camera.updateProjectionMatrix() }
                    sightWas = true
                } else {
                    if (sightWas) { camera.fov = 40; camera.updateProjectionMatrix(); orbit.target.set(0, hh * 0.5, 0); camera.position.set(hh * 0.8, hh * 0.7, hh * 1.5); sightWas = false }
                    orbit.update()
                }
                renderer.render(scene, camera)
            }
            raf = requestAnimationFrame(tick)
            cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); orbit.dispose(); renderer.dispose(); renderer.domElement.remove() }
        })()
        return () => { dead = true; cleanup() }
    }, [side, book, who, glbUrl])
    const clip = side?.clips[c.clip]
    if (err) return <div className="rounded-lg border border-line p-6 text-center text-[12px] text-muted" data-testid="tp-error">Third-person unavailable: {err}</div>
    if (!side || !book || !clip) return <div className="rounded-lg border border-line p-6 text-center text-[12px] text-muted">Loading avatar...</div>
    const set = (p: Partial<Ctl>) => setC((x) => { const n = { ...x, ...p }; ctl.current = n; return n })
    return (
        <div data-testid="tp-pane">
            <div ref={box} className="w-full overflow-hidden rounded-lg border border-line" data-testid="tp-canvas" />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
                <label>Avatar <select value={who} onChange={(e) => setWho(Number(e.target.value))} data-testid="tp-avatar" className="rounded border border-line bg-transparent px-1 py-0.5">{book.avatars.map((a, i) => <option key={a.body} value={i}>{a.body}</option>)}</select></label>
                <select value={c.clip} onChange={(e) => { setShownT(0); set({ clip: Number(e.target.value), t: 0 }) }} data-testid="tp-clip" className="rounded border border-line bg-transparent px-1 py-0.5">
                    {side.clips.map((k, i) => <option key={k.name} value={i}>{k.name}</option>)}
                </select>
                <button onClick={() => set({ playing: !c.playing })} data-testid="tp-play" className="rounded border border-line px-2 py-0.5">{c.playing ? "Pause" : "Play"}</button>
                <input type="range" min={0} max={clip.length} step={1 / side.fps} value={Math.min(shownT, clip.length)} onChange={(e) => { setShownT(Number(e.target.value)); set({ t: Number(e.target.value), playing: false }) }} data-testid="tp-scrub" className="min-w-40 flex-1" />
                <span className="tabular-nums text-muted">{shownT.toFixed(2)} / {clip.length.toFixed(2)} s</span>
                <label>Speed <select value={c.speed} onChange={(e) => set({ speed: Number(e.target.value) })} className="rounded border border-line bg-transparent px-1 py-0.5">{[0.1, 0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}x</option>)}</select></label>
                <label><input type="checkbox" checked={c.loop} onChange={(e) => set({ loop: e.target.checked })} /> Loop</label>
                {sight && <button onClick={() => setSightOn(!sightOn)} data-testid="tp-sight-toggle" title={`${sight.label}, aim ${sight.aim}`} className={`rounded border px-2 py-0.5 ${sightOn ? "border-sky-300 text-sky-300" : "border-line"}`}>{sightOn ? `Sight ${sightMagnification(sight)}` : "Orbit"}</button>}
                <span className="text-muted">Drag to orbit, wheel to zoom</span>
            </div>
        </div>
    )
}
