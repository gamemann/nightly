"use client"
import { useEffect, useRef, useState } from "react"
import type * as T from "three"

type Opts = { wire: boolean; unlit: boolean; bbox: boolean; grid: boolean; light: string }
const LIGHTS = ["studio", "outdoor", "dark rim", "flat"]
type Api = { apply: (o: Opts) => void; reset: () => void }

/** three.js viewer: orbit (left drag), pan (right drag), zoom (wheel); wireframe, textured/unlit, lighting presets, bounding box (metres) and grid. */
export function AssetViewer({ url, bbox }: { url: string; bbox?: number[] }) {
    const box = useRef<HTMLDivElement>(null)
    const api = useRef<Api | null>(null)
    const [o, setO] = useState<Opts>({ wire: false, unlit: false, bbox: true, grid: true, light: "studio" })
    const [state, setState] = useState("loading")
    const optsRef = useRef(o)
    optsRef.current = o
    useEffect(() => { api.current?.apply(o) }, [o])
    useEffect(() => {
        let dead = false
        let cleanup = () => {}
        void (async () => {
            const THREE = await import("three")
            const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
            const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js")
            if (dead || !box.current) return
            const el = box.current
            const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
            el.appendChild(renderer.domElement)
            const scene = new THREE.Scene()
            scene.background = new THREE.Color(0x15161a)
            const lights = new THREE.Group()
            scene.add(lights)
            const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 1000)
            const controls = new OrbitControls(camera, renderer.domElement)
            controls.enableDamping = true
            let root: T.Object3D | null = null
            let helper: T.Box3Helper | null = null
            let grid: T.GridHelper | null = null
            const sphere = new THREE.Sphere(new THREE.Vector3(), 1)
            const orig = new Map<T.Mesh, T.Material | T.Material[]>()
            const unlitCache = new Map<T.Material, T.Material>()
            const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix() }
            const ro = new ResizeObserver(resize)
            ro.observe(el)
            resize()
            const reset = () => {
                const r = sphere.radius
                camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(r * 2.6))
                controls.target.copy(sphere.center)
                controls.update()
            }
            const setLights = (name: string) => {
                lights.clear()
                const add = (l: T.Light, x = 0, y = 0, z = 0) => { l.position.set(x, y, z); lights.add(l) }
                if (name === "studio") { add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.4)); add(new THREE.DirectionalLight(0xffffff, 2.2), 2, 3, 2); add(new THREE.DirectionalLight(0x9db4ff, 0.8), -3, 1, -2) }
                else if (name === "outdoor") { add(new THREE.HemisphereLight(0xbfdcff, 0x5a4a32, 1.8)); add(new THREE.DirectionalLight(0xfff1d0, 3.2), 4, 6, 1) }
                else if (name === "dark rim") { add(new THREE.AmbientLight(0xffffff, 0.15)); add(new THREE.DirectionalLight(0xff9d5c, 3), -3, 1, -3); add(new THREE.DirectionalLight(0x5c9dff, 2.4), 3, 1, -3) }
                else add(new THREE.AmbientLight(0xffffff, 2.6))
            }
            const apply = (op: Opts) => {
                setLights(op.light)
                if (helper) helper.visible = op.bbox
                if (grid) grid.visible = op.grid
                root?.traverse((n) => {
                    const m = n as T.Mesh
                    if (!m.isMesh) return
                    if (!orig.has(m)) orig.set(m, m.material)
                    const base = orig.get(m)!
                    const conv = (x: T.Material): T.Material => {
                        if (!op.unlit) return x
                        let u = unlitCache.get(x)
                        if (!u) { const s = x as T.MeshStandardMaterial; u = new THREE.MeshBasicMaterial({ map: s.map ?? null, color: s.color ?? 0xffffff, vertexColors: s.vertexColors, transparent: s.transparent, opacity: s.opacity, side: s.side, alphaTest: s.alphaTest }); unlitCache.set(x, u) }
                        return u
                    }
                    m.material = Array.isArray(base) ? base.map(conv) : conv(base)
                    for (const x of Array.isArray(m.material) ? m.material : [m.material]) (x as T.MeshBasicMaterial).wireframe = op.wire
                })
            }
            api.current = { apply, reset }
            new GLTFLoader().load(url, (gltf) => {
                if (dead) return
                root = gltf.scene
                scene.add(root)
                const b = new THREE.Box3().setFromObject(root)
                b.getBoundingSphere(sphere)
                helper = new THREE.Box3Helper(b, 0x5eead4)
                scene.add(helper)
                grid = new THREE.GridHelper(Math.max(1, Math.ceil(sphere.radius * 4)), 20, 0x3a3d46, 0x24262d)
                grid.position.y = b.min.y
                scene.add(grid)
                camera.near = sphere.radius / 100; camera.far = sphere.radius * 100; camera.updateProjectionMatrix()
                reset()
                apply(optsRef.current)
                let tris = 0
                root.traverse((n) => { const m = n as T.Mesh; if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3 })
                setState(`ok ${Math.round(tris)} tris`)
                el.dataset.ready = "1"
            }, undefined, (e) => setState(`failed: ${(e as Error).message ?? e}`))
            let raf = 0
            const tick = () => { raf = requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera) }
            tick()
            cleanup = () => {
                cancelAnimationFrame(raf); ro.disconnect(); controls.dispose()
                scene.traverse((n) => { const m = n as T.Mesh; if (m.isMesh) { m.geometry.dispose(); for (const x of Array.isArray(m.material) ? m.material : [m.material]) x.dispose() } })
                renderer.dispose(); renderer.domElement.remove()
            }
        })()
        return () => { dead = true; api.current = null; cleanup() }
    }, [url])
    const btn = (on: boolean) => `rounded-md px-2 py-0.5 text-[12px] ${on ? "bg-sky-400/20 text-sky-200" : "bg-hover text-dim hover:text-fg"}`
    return (
        <div>
            <div ref={box} data-testid="asset-viewer" className="relative h-[460px] w-full overflow-hidden rounded-lg border border-line bg-[#15161a]">
                {state === "loading" && <div className="absolute inset-0 grid place-items-center text-[12px] text-muted">loading model</div>}
                {state.startsWith("failed") && <div className="absolute inset-0 grid place-items-center text-[12px] text-red-300">{state}</div>}
                <div className="pointer-events-none absolute bottom-1 left-2 text-[11px] text-muted">left drag orbit, right drag pan, wheel zoom{bbox?.length === 3 ? ` | bbox ${bbox.map((v) => v.toFixed(2)).join(" x ")} m` : ""}</div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button className={btn(o.wire)} onClick={() => setO({ ...o, wire: !o.wire })}>wireframe</button>
                <button className={btn(!o.unlit)} onClick={() => setO({ ...o, unlit: !o.unlit })}>{o.unlit ? "unlit (texture only)" : "lit"}</button>
                <button className={btn(o.bbox)} onClick={() => setO({ ...o, bbox: !o.bbox })}>bbox</button>
                <button className={btn(o.grid)} onClick={() => setO({ ...o, grid: !o.grid })}>grid</button>
                <select className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-[12px]" value={o.light} onChange={(e) => setO({ ...o, light: e.target.value })}>{LIGHTS.map((l) => <option key={l}>{l}</option>)}</select>
                <button className={btn(false)} onClick={() => api.current?.reset()}>reset view</button>
                <span className="text-[11px] text-muted">{state.startsWith("ok") ? state.slice(3) : ""}</span>
            </div>
        </div>
    )
}
