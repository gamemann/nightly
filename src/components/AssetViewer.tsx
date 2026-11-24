"use client"
import { useEffect, useRef, useState } from "react"
import type * as T from "three"

type Opts = { wire: boolean; unlit: boolean; bbox: boolean; grid: boolean; light: string; fly: boolean; collision: boolean; trigger: boolean; entity: boolean; view: View }
type View = "converted" | "original" | "split"
type Spawn = { x: number; y: number; z: number; yaw: number; team: string }
const LIGHTS = ["studio", "outdoor", "dark rim", "flat"]
/** An attachment mounted on the model: its glb, and the transform in the model's space (metres, rotation in degrees). */
export type Mounted = { key: string; url: string; pos: number[]; rot: number[]; scale: number[] }
type Api = { apply: (o: Opts) => void; reset: () => void; spawn: (i: number) => void; mount: (list: Mounted[]) => void }

/** three.js viewer: orbit (left drag), pan (right drag), zoom (wheel); wireframe, textured/unlit, lighting presets, bounding box (metres) and grid.
 *  `map` (a converted map GLB): starts in free-fly (click to capture the mouse; W/A/S/D move, mouse look, Shift fast, Space up, Ctrl down,
 *  wheel changes speed, Esc releases), with toggles for the collision / trigger / spawn overlay meshes (nodes named collision_*, trigger_*, entity_*)
 *  and jump-to-spawn from the spawn list in the scene extras. Orbit stays available as a toggle.
 *  `original` (a map's source BSP exported to GLB in the same frame): adds converted / original / split views; the split view draws the
 *  original on the left and the converted map on the right through ONE camera, so fly and orbit move both at once. */
export function AssetViewer({ url, bbox, textures, map, original, mounted }: { url: string; bbox?: number[]; textures?: { name: string; url: string }[]; map?: boolean; original?: string; mounted?: Mounted[] }) {
    const box = useRef<HTMLDivElement>(null)
    const api = useRef<Api | null>(null)
    const [o, setO] = useState<Opts>({ wire: false, unlit: false, bbox: !map, grid: !map, light: map ? "outdoor" : "studio", fly: !!map, collision: false, trigger: false, entity: true, view: "converted" })
    const [spawns, setSpawns] = useState<Spawn[]>([])
    const [speed, setSpeed] = useState(0)
    const [locked, setLocked] = useState(false)
    const [state, setState] = useState("loading")
    const [ostate, setOstate] = useState(original ? "loading" : "")
    const optsRef = useRef(o)
    optsRef.current = o
    const mountRef = useRef<Mounted[]>(mounted ?? [])
    mountRef.current = mounted ?? []
    useEffect(() => { api.current?.mount(mounted ?? []) }, [mounted])
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
            let rootO: T.Object3D | null = null
            let view: View = "converted"
            let helper: T.Box3Helper | null = null
            let grid: T.GridHelper | null = null
            const sphere = new THREE.Sphere(new THREE.Vector3(), 1)
            const orig = new Map<T.Mesh, T.Material | T.Material[]>()
            const unlitCache = new Map<T.Material, T.Material>()
            // free-fly state (map mode): yaw/pitch from the mouse while the pointer is locked, speed in metres per second
            const fly = { on: false, yaw: 0, pitch: 0, speed: 10, keys: new Set<string>() }
            const euler = new THREE.Euler(0, 0, 0, "YXZ")
            const setAngles = () => { euler.set(fly.pitch, fly.yaw, 0); camera.quaternion.setFromEuler(euler) }
            const setFly = (on: boolean) => {
                if (on === fly.on) return
                fly.on = on
                controls.enabled = !on
                if (on) { const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ"); fly.yaw = e.y; fly.pitch = e.x; setAngles() }
                else { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); const d = new THREE.Vector3(); camera.getWorldDirection(d); controls.target.copy(camera.position).addScaledVector(d, Math.max(1, sphere.radius * 0.2)); controls.update() }
            }
            const onLock = () => { const l = document.pointerLockElement === renderer.domElement; setLocked(l); if (!l) fly.keys.clear() }
            const onMove = (e: MouseEvent) => {
                if (!fly.on || document.pointerLockElement !== renderer.domElement) return
                fly.yaw -= e.movementX * 0.0022; fly.pitch = Math.max(-1.55, Math.min(1.55, fly.pitch - e.movementY * 0.0022)); setAngles()
            }
            const FLY_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]
            const onKey = (down: boolean) => (e: KeyboardEvent) => {
                if (!fly.on || document.pointerLockElement !== renderer.domElement || !FLY_KEYS.includes(e.code)) return
                e.preventDefault()
                if (down) fly.keys.add(e.code); else fly.keys.delete(e.code)
            }
            const kd = onKey(true), ku = onKey(false)
            const onWheel = (e: WheelEvent) => {
                if (!fly.on || document.pointerLockElement !== renderer.domElement) return
                e.preventDefault()
                fly.speed = Math.max(0.1, Math.min(2000, fly.speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2))); setSpeed(fly.speed)
            }
            const onClick = () => { if (fly.on && document.pointerLockElement !== renderer.domElement) void renderer.domElement.requestPointerLock() }
            document.addEventListener("pointerlockchange", onLock); document.addEventListener("mousemove", onMove)
            document.addEventListener("keydown", kd); document.addEventListener("keyup", ku)
            renderer.domElement.addEventListener("wheel", onWheel, { passive: false }); renderer.domElement.addEventListener("click", onClick)
            const spawnList: Spawn[] = []
            const toSpawn = (i: number) => {
                const p = spawnList[i]
                if (!p) return
                camera.position.set(p.x, p.y + 1.7, p.z)
                fly.yaw = (p.yaw * Math.PI) / 180 - Math.PI / 2; fly.pitch = 0; setAngles()   // Source yaw 0 = +X, 90 = +Y (= -Z in glTF); a three.js camera at yaw 0 looks down -Z
            }
            const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = (view === "split" ? w / 2 : w) / h; camera.updateProjectionMatrix() }
            const ro = new ResizeObserver(resize)
            ro.observe(el)
            resize()
            const reset = () => {
                const r = sphere.radius
                camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(r * 2.6))
                controls.target.copy(sphere.center)
                controls.update()
                if (fly.on) { const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ"); fly.yaw = e.y; fly.pitch = e.x }
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
                setFly(!!map && op.fly)
                if (view !== op.view) { view = op.view; resize() }
                for (const r of [root, rootO]) r?.traverse((n) => {
                    const m = n as T.Mesh
                    if (map && n.name) { if (n.name.startsWith("collision_")) n.visible = op.collision; else if (n.name.startsWith("trigger_")) n.visible = op.trigger; else if (n.name.startsWith("entity_")) n.visible = op.entity }
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
            // attachments: each is its own glb parented under the model root at the stored transform (the game places it at the socket with no offset)
            const attObjs = new Map<string, T.Object3D>()
            const attCache = new Map<string, Promise<T.Object3D>>()
            let attSeq = 0
            const mount = (list: Mounted[]) => {
                if (!root) return
                const seq = ++attSeq, want = new Map(list.map((m) => [m.key, m]))
                for (const [k, ob] of attObjs) if (!want.has(k)) { root.remove(ob); attObjs.delete(k) }
                for (const m of list) {
                    let p = attCache.get(m.url)
                    if (!p) { p = new GLTFLoader().loadAsync(m.url).then((g) => g.scene); attCache.set(m.url, p) }
                    void p.then((src) => {
                        if (dead || seq !== attSeq || !root || attObjs.has(m.key)) return
                        const ob = src.clone(true)
                        ob.position.set(m.pos[0] ?? 0, m.pos[1] ?? 0, m.pos[2] ?? 0)
                        ob.rotation.set(((m.rot[0] ?? 0) * Math.PI) / 180, ((m.rot[1] ?? 0) * Math.PI) / 180, ((m.rot[2] ?? 0) * Math.PI) / 180)
                        ob.scale.set(m.scale[0] ?? 1, m.scale[1] ?? 1, m.scale[2] ?? 1)
                        ob.name = `attachment_${m.key}`
                        root.add(ob); attObjs.set(m.key, ob); apply(optsRef.current)
                        el.dataset.attached = [...attObjs.keys()].sort().join(",")
                    }, () => setState(`failed: attachment ${m.key}`))
                }
                if (!list.length) el.dataset.attached = ""
            }
            api.current = { apply, reset, spawn: toSpawn, mount }
            if (original) {
                new GLTFLoader().load(original, (g) => {
                    if (dead) return
                    rootO = g.scene; scene.add(rootO); apply(optsRef.current)
                    let t = 0
                    rootO.traverse((n) => { const m = n as T.Mesh; if (m.isMesh) t += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3 })
                    setOstate(`ok ${Math.round(t)} tris`)
                }, undefined, (e) => setOstate(`failed: ${(e as Error).message ?? e}`))
            }
            // external texture URIs (Textures/colormap.png) are relative to the source file, which the browser cannot see: map them by stem to the file route
            const mgr = new THREE.LoadingManager()
            mgr.setURLModifier((u) => {
                if (u.startsWith("data:") || u.startsWith("blob:")) return u
                const stem = decodeURIComponent(u.split("?")[0].split("/").pop() ?? "").replace(/\.[^.]+$/, "")
                return textures?.find((t) => t.name === stem)?.url ?? u
            })
            new GLTFLoader(mgr).load(url, (gltf) => {
                if (dead) return
                root = gltf.scene
                scene.add(root)
                // props whose model is missing arrive as pink boxes (missing_*) with extras.label: pin the label above each as a sprite
                if (map) {
                    const boxes: T.Object3D[] = []
                    root.traverse((n) => { if (n.name.startsWith("missing_") && typeof n.userData?.label === "string") boxes.push(n) })
                    for (const n of boxes.slice(0, 200)) {
                        const c = document.createElement("canvas"); c.width = 256; c.height = 48
                        const cx = c.getContext("2d")!; cx.fillStyle = "rgba(20,20,24,.8)"; cx.fillRect(0, 0, 256, 48); cx.fillStyle = "#ff9ad0"; cx.font = "bold 22px monospace"; cx.textAlign = "center"; cx.fillText(String(n.userData.label).slice(0, 22), 128, 32)
                        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }))
                        sp.scale.set(2, 0.375, 1); sp.position.y = 1; sp.name = "entity_label"
                        n.add(sp)
                    }
                }
                const b = new THREE.Box3().setFromObject(root)
                b.getBoundingSphere(sphere)
                helper = new THREE.Box3Helper(b, 0x5eead4)
                scene.add(helper)
                grid = new THREE.GridHelper(Math.max(1, Math.ceil(sphere.radius * 4)), 20, 0x3a3d46, 0x24262d)
                grid.position.y = b.min.y
                scene.add(grid)
                camera.near = map ? 0.05 : sphere.radius / 100; camera.far = map ? sphere.radius * 6 : sphere.radius * 100; camera.updateProjectionMatrix()
                reset()
                if (map) {
                    const ex = (gltf.scene.userData?.map ?? (gltf.scenes[0]?.userData as { map?: { spawns?: Spawn[] } } | undefined)?.map) as { spawns?: Spawn[] } | undefined
                    spawnList.push(...(ex?.spawns ?? [])); setSpawns(spawnList.slice())
                    fly.speed = Math.max(2, Math.round(sphere.radius / 12)); setSpeed(fly.speed)
                    if (spawnList.length) toSpawn(0)
                }
                apply(optsRef.current)
                let tris = 0
                root.traverse((n) => { const m = n as T.Mesh; if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3 })
                setState(`ok ${Math.round(tris)} tris`)
                el.dataset.ready = "1"
                mount(mountRef.current)
            }, (ev) => { if (ev.total > 0) setState(`loading ${Math.round((100 * ev.loaded) / ev.total)}%`) }, (e) => setState(`failed: ${(e as Error).message ?? e}`))
            let raf = 0
            const clock = new THREE.Clock()
            const tick = () => {
                raf = requestAnimationFrame(tick)
                const dt = Math.min(0.1, clock.getDelta())
                if (fly.on) {
                    const k = fly.keys, v = fly.speed * dt * (k.has("ShiftLeft") || k.has("ShiftRight") ? 4 : 1)
                    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd)
                    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize()
                    if (k.has("KeyW")) camera.position.addScaledVector(fwd, v)
                    if (k.has("KeyS")) camera.position.addScaledVector(fwd, -v)
                    if (k.has("KeyD")) camera.position.addScaledVector(right, v)
                    if (k.has("KeyA")) camera.position.addScaledVector(right, -v)
                    if (k.has("Space")) camera.position.y += v
                    if (k.has("ControlLeft") || k.has("ControlRight")) camera.position.y -= v
                } else controls.update()
                const w = el.clientWidth, h = el.clientHeight
                const show = (c: boolean, orig: boolean) => { if (root) root.visible = c; if (rootO) rootO.visible = orig }
                if (view === "split") {
                    renderer.setScissorTest(true)
                    renderer.setViewport(0, 0, w / 2, h); renderer.setScissor(0, 0, w / 2, h); show(false, true); renderer.render(scene, camera)
                    renderer.setViewport(w / 2, 0, w / 2, h); renderer.setScissor(w / 2, 0, w / 2, h); show(true, false); renderer.render(scene, camera)
                    renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h)
                } else { show(view !== "original", view === "original"); renderer.render(scene, camera) }
            }
            tick()
            cleanup = () => {
                cancelAnimationFrame(raf); ro.disconnect(); controls.dispose()
                document.removeEventListener("pointerlockchange", onLock); document.removeEventListener("mousemove", onMove)
                document.removeEventListener("keydown", kd); document.removeEventListener("keyup", ku)
                if (document.pointerLockElement === renderer.domElement) document.exitPointerLock()
                scene.traverse((n) => { const m = n as T.Mesh; if (m.isMesh) { m.geometry.dispose(); for (const x of Array.isArray(m.material) ? m.material : [m.material]) x.dispose() } })
                renderer.dispose(); renderer.domElement.remove()
            }
        })()
        return () => { dead = true; api.current = null; cleanup() }
    }, [url, original])
    const btn = (on: boolean) => `rounded-md px-2 py-0.5 text-[12px] ${on ? "bg-sky-400/20 text-sky-200" : "bg-hover text-dim hover:text-fg"}`
    return (
        <div>
            <div ref={box} data-testid="asset-viewer" className={`relative ${map ? "h-[600px]" : "h-[460px]"} w-full overflow-hidden rounded-lg border border-line bg-[#15161a]`}>
                {state === "loading" && <div className="absolute inset-0 grid place-items-center text-[12px] text-muted">loading model</div>}
                {state.startsWith("failed") && <div className="absolute inset-0 grid place-items-center text-[12px] text-red-300">{state}</div>}
                {original && o.view === "split" && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-sky-300/60" />}
                {original && o.view !== "converted" && <div className="pointer-events-none absolute left-2 top-1 text-[11px] text-sky-200">{o.view === "split" ? "original (left) | converted (right)" : "original"}{ostate.startsWith("failed") ? ` ${ostate}` : ""}</div>}
                <div className="pointer-events-none absolute bottom-1 left-2 text-[11px] text-muted">{map && o.fly ? (locked ? `W/A/S/D move, mouse look, Shift fast, Space up, Ctrl down, wheel speed (${speed.toFixed(1)} m/s), Esc releases` : "click the view to fly (captures the mouse)") : "left drag orbit, right drag pan, wheel zoom"}{bbox?.length === 3 ? ` | bbox ${bbox.map((v) => v.toFixed(2)).join(" x ")} m` : ""}</div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {original && (["converted", "original", "split"] as View[]).map((v) => <button key={v} className={btn(o.view === v)} onClick={() => setO({ ...o, view: v })} data-testid={`view-${v}`}>{v}</button>)}
                {map && <button className={btn(o.fly)} onClick={() => setO({ ...o, fly: !o.fly })} data-testid="fly-toggle">{o.fly ? "fly camera" : "orbit camera"}</button>}
                {map && <button className={btn(o.collision)} onClick={() => setO({ ...o, collision: !o.collision })}>collision</button>}
                {map && <button className={btn(o.trigger)} onClick={() => setO({ ...o, trigger: !o.trigger })}>triggers</button>}
                {map && <button className={btn(o.entity)} onClick={() => setO({ ...o, entity: !o.entity })}>spawns</button>}
                {map && spawns.length > 0 && <select className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-[12px]" value="" onChange={(e) => { if (e.target.value) api.current?.spawn(Number(e.target.value)) }}><option value="">go to spawn</option>{spawns.map((p, i) => <option key={i} value={i}>{`${p.team ? p.team + " " : ""}#${i + 1}`}</option>)}</select>}
                <button className={btn(o.wire)} onClick={() => setO({ ...o, wire: !o.wire })}>wireframe</button>
                <button className={btn(!o.unlit)} onClick={() => setO({ ...o, unlit: !o.unlit })}>{o.unlit ? "unlit (texture only)" : "lit"}</button>
                <button className={btn(o.bbox)} onClick={() => setO({ ...o, bbox: !o.bbox })}>bbox</button>
                <button className={btn(o.grid)} onClick={() => setO({ ...o, grid: !o.grid })}>grid</button>
                <select className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-[12px]" value={o.light} onChange={(e) => setO({ ...o, light: e.target.value })}>{LIGHTS.map((l) => <option key={l}>{l}</option>)}</select>
                <button className={btn(false)} onClick={() => api.current?.reset()}>reset view</button>
                <span className="text-[11px] text-muted">{state.startsWith("ok") ? state.slice(3) : ""}{original && ostate.startsWith("ok") ? ` (original ${ostate.slice(3)})` : ""}</span>
            </div>
        </div>
    )
}
