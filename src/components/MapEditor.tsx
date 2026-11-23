"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import type * as T from "three"
import { aggOf, buildItems, EMPTY, TOP, type Editor, type Item } from "./mapModel"

type Mode = "textured" | "unlit" | "wire" | "flat"
type Filter = "all" | "brushes" | "entities"
type Eng = { focus: (i: Item) => void; fromSpawn: (i: Item) => void; thumb: (m: string) => string; setHi: (mat: string | null, ids: number[]) => void; cam: () => string; reset: () => void }
const fmt = (a?: number[]) => (a ? a.map((v) => v.toFixed(2)).join(", ") : "-")
const hex = (c: number[]) => `rgb(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(",")})`
const centre = (b: T.Box3) => b.min.clone().add(b.max).multiplyScalar(0.5).toArray()
const BRUSHES = new Set<string>([TOP.world, TOP.hulls, TOP.triggers])

/** Read-only map editor (Hammer/Godot style): outliner with visgroups, inspector with the key/value list, materials and props panels,
 *  view modes, grid/axes and a 3-view orthographic layout. Everything comes from the converted GLB (node extras + scene extras.map.editor). */
export function MapEditor({ url }: { url: string }) {
    const box = useRef<HTMLDivElement>(null)
    const eng = useRef<Eng | null>(null)
    const [items, setItems] = useState<Item[]>([])
    const [ed, setEd] = useState<Editor>(EMPTY)
    const [state, setState] = useState("loading")
    const [sel, setSel] = useState<number | null>(null)
    const [hiddenG, setHiddenG] = useState<Set<string>>(new Set([TOP.hulls, TOP.triggers]))
    const [hiddenI, setHiddenI] = useState<Set<number>>(new Set())
    const [open, setOpen] = useState<Set<string>>(new Set())
    const [q, setQ] = useState("")
    const [mode, setMode] = useState<Mode>("textured")
    const [filter, setFilter] = useState<Filter>("all")
    const [grid, setGrid] = useState(true)
    const [axes, setAxes] = useState(true)
    const [panes, setPanes] = useState(1)
    const [hiMat, setHiMat] = useState<string | null>(null)
    const [hiProp, setHiProp] = useState<string | null>(null)
    const [hud, setHud] = useState("")
    const st = useRef({ items, hiddenG, hiddenI, mode, filter, grid, axes, panes, sel })
    st.current = { items, hiddenG, hiddenI, mode, filter, grid, axes, panes, sel }
    const apply = useRef<() => void>(() => {})
    const pick = useRef<(id: number | null) => void>(() => {})
    pick.current = (id) => { setSel(id); if (id != null) { const it = items[id]; setOpen((o) => new Set(o).add(it.top).add(`${it.top}/${it.sub}`)) } }
    useEffect(() => { apply.current() }, [items, hiddenG, hiddenI, mode, filter, grid, axes, panes, sel])
    useEffect(() => {
        const ids = hiMat ? [] : hiProp ? items.filter((i) => i.top === TOP.props && i.raw.model === hiProp).map((i) => i.id) : []
        eng.current?.setHi(hiMat, ids)
    }, [hiMat, hiProp, items])

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
            renderer.setScissorTest(true)
            el.appendChild(renderer.domElement)
            const scene = new THREE.Scene()
            scene.background = new THREE.Color(0x15161a)
            const rig = new THREE.Group()
            rig.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 3.2)); const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(0.4, 1, 0.3); rig.add(sun)
            scene.add(rig)
            const persp = new THREE.PerspectiveCamera(60, 1, 0.05, 4000)
            const controls = new OrbitControls(persp, renderer.domElement)
            controls.enableDamping = true
            const ortho = ["top", "front", "side"].map(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 8000))
            const o = { zoom: 50, c: new THREE.Vector3() }
            const gridH = new THREE.GridHelper(200, 100, 0x4a5060, 0x2a2e38)
            const axesH = new THREE.AxesHelper(5)
            scene.add(gridH, axesH)
            const hi = new THREE.Group(); scene.add(hi)
            const outline = new THREE.Box3Helper(new THREE.Box3(), 0xffd24a); outline.visible = false; scene.add(outline)
            const keys = new Set<string>()
            let root: T.Object3D | null = null
            let markers: T.Group | null = null
            let its: Item[] = []
            const base = new Map<T.Mesh, T.Material | T.Material[]>()
            const alt = new Map<string, T.Material>()
            const byObj = new Map<string, number>()
            const sphere = new THREE.Sphere(new THREE.Vector3(), 10)
            let hiMat: string | null = null
            const swap = (m: T.Material, mode: Mode, name: string): T.Material => {
                if (mode === "textured") return m
                const key = `${mode}|${m.uuid}|${name}`
                let r = alt.get(key)
                if (!r) {
                    const s = m as T.MeshStandardMaterial
                    if (mode === "wire") r = new THREE.MeshBasicMaterial({ color: 0xbfe8d0, wireframe: true })
                    else if (mode === "unlit") r = new THREE.MeshBasicMaterial({ map: s.map ?? null, color: s.color ?? 0xffffff, transparent: s.transparent, opacity: s.opacity, side: THREE.DoubleSide })
                    else { const c = new THREE.Color(); let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; c.setHSL((h % 360) / 360, 0.55, 0.52); r = new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide }) }
                    alt.set(key, r)
                }
                return r
            }
            const refresh = () => {
                const s = st.current
                if (!root) return
                const tops = new Set<string>()
                const hideTop = (t: string) => s.hiddenG.has(t)
                for (const it of s.items) {
                    let v = !hideTop(it.top) && !s.hiddenG.has(`${it.top}/${it.sub}`) && !s.hiddenI.has(it.id)
                    if (s.filter === "brushes" && !BRUSHES.has(it.top)) v = false
                    if (s.filter === "entities" && it.top === TOP.world) v = false
                    if (it.group && markers) { const a = aggOf(markers, it.group); if (a) a.visible = v }
                    else if (it.obj) it.obj.visible = v
                    tops.add(it.top)
                }
                root.traverse((c) => {
                    const m = c as T.Mesh
                    if (!m.isMesh) return
                    if (!base.has(m)) base.set(m, m.material)
                    const b = base.get(m)!
                    const own = m.name.startsWith("collision_") || m.name.startsWith("trigger_") || m.name.startsWith("entity_")
                    if (own) return
                    const name = String(m.userData.material ?? m.parent?.userData?.model ?? m.name)
                    m.material = Array.isArray(b) ? b.map((x) => swap(x, s.mode, name)) : swap(b, s.mode, name)
                })
                rig.visible = s.mode === "textured"
                gridH.visible = s.grid; axesH.visible = s.axes
                const it = s.sel != null ? s.items[s.sel] : null
                outline.visible = !!it?.box
                if (it?.box) outline.box.copy(it.box)
                scene.background = new THREE.Color(s.mode === "textured" ? 0x15161a : 0x0d0e11)
            }
            const place = (b: T.Box3) => {
                const c = b.getCenter(new THREE.Vector3()); const r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1)
                return { c, r }
            }
            const e: Eng = {
                focus: (i) => {
                    if (!i.box) return
                    const { c, r } = place(i.box)
                    const d = persp.position.clone().sub(controls.target); if (d.length() < 1e-3) d.set(1, 0.7, 1)
                    d.setLength(Math.max(r * 2.5, 2)); controls.target.copy(c); persp.position.copy(c).add(d); o.c.copy(c); o.zoom = Math.max(r * 2, 3)
                },
                fromSpawn: (i) => {
                    if (!i.pos) return
                    const y = ((i.yaw ?? 0) * Math.PI) / 180
                    persp.position.set(i.pos[0], i.pos[1] + 1.6, i.pos[2]); controls.target.set(i.pos[0] + Math.cos(y) * 3, i.pos[1] + 1.6, i.pos[2] - Math.sin(y) * 3)
                },
                thumb: (name) => {
                    let url = ""
                    root?.traverse((c) => {
                        const m = c as T.Mesh
                        if (url || !m.isMesh || m.userData.material !== name) return
                        const img = ((base.get(m) ?? m.material) as T.MeshStandardMaterial).map?.image as CanvasImageSource | undefined
                        if (!img) return
                        const cv = document.createElement("canvas"); cv.width = cv.height = 64
                        try { cv.getContext("2d")!.drawImage(img, 0, 0, 64, 64); url = cv.toDataURL() } catch { url = "" }
                    })
                    return url
                },
                setHi: (mat, ids) => {
                    hi.clear(); hiMat = mat
                    const wire = new THREE.MeshBasicMaterial({ color: 0xff2fd0, wireframe: true, depthTest: false, transparent: true, opacity: 0.9 })
                    if (mat) root?.traverse((c) => { const m = c as T.Mesh; if (m.isMesh && m.userData.material === mat) { const w = new THREE.Mesh(m.geometry, wire); w.renderOrder = 9; hi.add(w) } })
                    for (const id of ids) { const b = its[id]?.box; if (b) hi.add(new THREE.Box3Helper(b, 0xff2fd0)) }
                },
                cam: () => `cam ${fmt(persp.position.toArray())}  target ${fmt(controls.target.toArray())}`,
                reset: () => {},
            }
            eng.current = e
            apply.current = refresh
            new GLTFLoader().load(url, (gltf) => {
                if (dead) return
                root = gltf.scene; scene.add(root)
                const ex = (gltf.scenes[0]?.userData ?? gltf.scene.userData) as { map?: { editor?: Editor; bounds?: { min: number[]; max: number[] } } }
                const editor = { ...EMPTY, ...(ex.map?.editor ?? {}) }
                const b = ex.map?.bounds
                const built = buildItems(THREE, root, editor)
                its = built.items; markers = built.markers; scene.add(markers)
                for (const it of its) if (it.obj) byObj.set(it.obj.uuid, it.id)
                const bb = b ? new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)) : new THREE.Box3().setFromObject(root)
                const { c, r } = place(bb)
                sphere.set(c, r); persp.position.copy(c).add(new THREE.Vector3(r * 0.9, r * 0.6, r * 0.9)); controls.target.copy(c); o.c.copy(c); o.zoom = r * 0.8
                gridH.position.set(c.x, bb.min.y, c.z); gridH.scale.setScalar(Math.max(1, r / 100)); axesH.position.set(bb.min.x, bb.min.y, bb.min.z); axesH.scale.setScalar(Math.max(1, r / 20))
                setEd(editor); st.current.items = its; setItems(its); setState("ready"); refresh()
            }, undefined, (err) => setState(`failed: ${(err as Error)?.message ?? err}`))

            // layout: 1 = perspective, 4 = perspective + top / front / side orthographic (scissored viewports)
            const rect = () => ({ w: el.clientWidth, h: el.clientHeight })
            const panesRect = (n: number) => { const { w, h } = rect(); return n === 1 ? [[0, 0, w, h]] : [[0, h / 2, w / 2, h / 2], [w / 2, h / 2, w / 2, h / 2], [0, 0, w / 2, h / 2], [w / 2, 0, w / 2, h / 2]] }
            const paneAt = (x: number, y: number) => panesRect(st.current.panes).findIndex(([px, py, pw, ph]) => x >= px && x < px + pw && y >= py && y < py + ph)
            const setOrtho = (cam: T.OrthographicCamera, i: number, asp: number) => {
                const d = Math.max(sphere.radius * 3, 50)
                cam.left = -o.zoom * asp; cam.right = o.zoom * asp; cam.top = o.zoom; cam.bottom = -o.zoom; cam.far = d * 4
                if (i === 0) { cam.position.set(o.c.x, o.c.y + d, o.c.z); cam.up.set(0, 0, -1) }
                else if (i === 1) { cam.position.set(o.c.x, o.c.y, o.c.z + d); cam.up.set(0, 1, 0) }
                else { cam.position.set(o.c.x + d, o.c.y, o.c.z); cam.up.set(0, 1, 0) }
                cam.lookAt(o.c); cam.updateProjectionMatrix()
            }
            let raf = 0, last = performance.now(), hudT = 0
            const loop = (now: number) => {
                raf = requestAnimationFrame(loop)
                const dt = Math.min((now - last) / 1000, 0.1); last = now
                const { w, h } = rect()
                if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false)
                renderer.domElement.style.width = `${w}px`; renderer.domElement.style.height = `${h}px`
                if (keys.size) {
                    const sp = Math.max(sphere.radius / 6, 2) * dt * (keys.has("shift") ? 4 : 1)
                    const f = new THREE.Vector3(); persp.getWorldDirection(f); const r = new THREE.Vector3().crossVectors(f, persp.up).normalize()
                    const mv = new THREE.Vector3()
                    if (keys.has("w")) mv.add(f); if (keys.has("s")) mv.sub(f); if (keys.has("d")) mv.add(r); if (keys.has("a")) mv.sub(r); if (keys.has(" ")) mv.y += 1; if (keys.has("c")) mv.y -= 1
                    mv.multiplyScalar(sp); persp.position.add(mv); controls.target.add(mv)
                }
                controls.update()
                const n = st.current.panes
                const R = panesRect(n)
                R.forEach(([x, y, pw, ph], i) => {
                    renderer.setViewport(x, y, pw, ph); renderer.setScissor(x, y, pw, ph)
                    let cam: T.Camera = persp
                    if (i === 0) { persp.aspect = pw / ph; persp.updateProjectionMatrix() } else { setOrtho(ortho[i - 1], i - 1, pw / ph); cam = ortho[i - 1] }
                    renderer.render(scene, cam)
                })
                if (now - hudT > 250) { hudT = now; setHud(e.cam()) }
            }
            raf = requestAnimationFrame(loop)

            // input: ortho panes pan/zoom, the perspective pane orbits; click (no drag) selects through a ray
            let down: { x: number; y: number; pane: number; px: number; py: number } | null = null
            const local = (ev: PointerEvent | WheelEvent) => { const r = el.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top] }
            const onDown = (ev: PointerEvent) => { const [x, y] = local(ev); const pane = paneAt(x, y); controls.enabled = pane <= 0; down = { x, y, pane, px: x, py: y }; el.focus() }
            const onMove = (ev: PointerEvent) => {
                if (!down || down.pane <= 0) return
                const [x, y] = local(ev); const R = panesRect(st.current.panes)[down.pane]; const upp = (o.zoom * 2) / R[3]
                const dx = (x - down.px) * upp, dy = (y - down.py) * upp; down.px = x; down.py = y
                if (down.pane === 1) { o.c.x -= dx; o.c.z -= dy } else if (down.pane === 2) { o.c.x -= dx; o.c.y += dy } else { o.c.z += dx; o.c.y += dy }
            }
            const onUp = (ev: PointerEvent) => {
                const d = down; down = null
                if (!d || Math.hypot(d.x - local(ev)[0], d.y - local(ev)[1]) > 4 || d.pane > 0) return
                const [x, y] = local(ev); const [px, py, pw, ph] = panesRect(st.current.panes)[0]
                const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((x - px) / pw) * 2 - 1, -((y - py) / ph) * 2 + 1), persp)
                const hits = ray.intersectObjects([root, markers].filter(Boolean) as T.Object3D[], true)
                for (const h of hits) {
                    let n: T.Object3D | null = h.object, vis = true, id: number | undefined
                    while (n) { if (!n.visible) vis = false; if (id === undefined && byObj.has(n.uuid)) id = byObj.get(n.uuid); n = n.parent }
                    if (vis && id !== undefined) { pick.current(id); return }
                }
                pick.current(null)
            }
            const onWheel = (ev: WheelEvent) => { const [x, y] = local(ev); if (paneAt(x, y) > 0) { ev.preventDefault(); o.zoom = Math.max(0.5, o.zoom * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)) } }
            const onKey = (ev: KeyboardEvent, on: boolean) => { const k = ev.key.toLowerCase(); if ("wasdc ".includes(k) && k.length === 1 || k === "shift") { if (on) keys.add(k); else keys.delete(k); if (k === " ") ev.preventDefault() } }
            const kd = (ev: KeyboardEvent) => onKey(ev, true), ku = (ev: KeyboardEvent) => onKey(ev, false)
            el.addEventListener("pointerdown", onDown, true); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp)
            el.addEventListener("wheel", onWheel, { passive: false, capture: true }); el.addEventListener("keydown", kd); el.addEventListener("keyup", ku); el.addEventListener("blur", () => keys.clear())
            cleanup = () => {
                cancelAnimationFrame(raf); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp)
                controls.dispose(); renderer.dispose(); renderer.domElement.remove(); eng.current = null; apply.current = () => {}
            }
        })()
        return () => { dead = true; cleanup() }
    }, [url])

    // outliner tree: top group -> sub group -> items, filtered by the search text
    const tree = useMemo(() => {
        const needle = q.trim().toLowerCase()
        const m = new Map<string, Map<string, Item[]>>()
        for (const t of Object.values(TOP)) m.set(t, new Map())
        for (const it of items) {
            if (needle && !`${it.label} ${it.sub} ${it.cls} ${it.kind} ${it.material ?? ""}`.toLowerCase().includes(needle)) continue
            const s = m.get(it.top)!; const l = s.get(it.sub); if (l) l.push(it); else s.set(it.sub, [it])
        }
        return m
    }, [items, q])
    const toggleG = (k: string) => setHiddenG((s) => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n })
    const toggleI = (id: number) => setHiddenI((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n })
    const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n })
    const it = sel != null ? items[sel] : null
    const kinds = useMemo(() => {
        const c: Record<string, number> = {}
        for (const i of items) { const k = i.top === TOP.world ? (i.kind === "translucent" ? "translucent brushes" : "solid brushes") : i.top === TOP.hulls ? `hull:${i.kind}` : i.top === TOP.triggers ? `trigger:${i.kind}` : i.top === TOP.props ? (i.sub.endsWith("[missing]") ? "props (missing)" : "props") : i.top === TOP.spawns ? "spawns" : i.cls; c[k] = (c[k] ?? 0) + (i.top === TOP.world ? 1 : 1) }
        return c
    }, [items])
    const worldTris = items.filter((i) => i.top === TOP.world).reduce((s, i) => s + (i.tris ?? 0), 0)
    const btn = (on: boolean) => `rounded border px-2 py-0.5 text-[11px] ${on ? "border-sky-300 text-fg" : "border-line text-dim hover:text-fg"}`

    return (
        <div data-testid="map-editor" className="rounded-lg border border-line bg-panel/40">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-2 text-[11px]">
                <span className="text-muted">View</span>
                {(["textured", "unlit", "wire", "flat"] as Mode[]).map((m) => <button key={m} onClick={() => setMode(m)} className={btn(mode === m)}>{m === "textured" ? "3D lit" : m === "unlit" ? "3D unlit" : m === "wire" ? "wireframe" : "flat colour"}</button>)}
                <span className="ml-2 text-muted">Show</span>
                {(["all", "brushes", "entities"] as Filter[]).map((f) => <button key={f} onClick={() => setFilter(f)} className={btn(filter === f)}>{f === "all" ? "everything" : `${f} only`}</button>)}
                <span className="ml-2 text-muted">Layout</span>
                <button onClick={() => setPanes(1)} className={btn(panes === 1)}>3D</button><button onClick={() => setPanes(4)} className={btn(panes === 4)}>3D + top/front/side</button>
                <button onClick={() => setGrid(!grid)} className={btn(grid)}>grid</button><button onClick={() => setAxes(!axes)} className={btn(axes)}>axes</button>
                <span className="ml-auto text-muted">{state !== "ready" ? state : "drag: orbit, right: pan, wheel: zoom, WASD/C/Space: fly, click: select"}</span>
            </div>
            <div className="flex flex-wrap gap-1 border-b border-line p-2 text-[11px]" data-testid="map-kinds">
                {Object.entries(kinds).map(([k, n]) => <span key={k} className="rounded bg-panel-2 px-1.5 py-0.5 text-dim">{k} <b className="text-fg">{n.toLocaleString("en-GB")}</b></span>)}
                <span className="rounded bg-panel-2 px-1.5 py-0.5 text-dim">brush triangles <b className="text-fg">{worldTris.toLocaleString("en-GB")}</b></span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "260px minmax(0,1fr) 300px", height: 620 }}>
                <div className="flex min-h-0 flex-col border-r border-line text-[12px]">
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search outliner" className="m-2 rounded border border-line bg-panel px-2 py-1 text-[12px]" />
                    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" data-testid="outliner">
                        {[...tree.entries()].map(([top, subs]) => {
                            const n = [...subs.values()].reduce((s, l) => s + l.length, 0)
                            if (!n) return null
                            return (
                                <div key={top}>
                                    <div className="flex items-center gap-1 py-0.5 font-medium">
                                        <input type="checkbox" checked={!hiddenG.has(top)} onChange={() => toggleG(top)} title="visgroup" />
                                        <button onClick={() => toggleOpen(top)} className="flex-1 text-left">{open.has(top) ? "v" : ">"} {top} <span className="text-muted">{n}</span></button>
                                    </div>
                                    {open.has(top) && [...subs.entries()].sort((a, b) => b[1].length - a[1].length).map(([sub, list]) => {
                                        const k = `${top}/${sub}`
                                        return (
                                            <div key={k} className="ml-3">
                                                <div className="flex items-center gap-1 py-0.5">
                                                    <input type="checkbox" checked={!hiddenG.has(k)} onChange={() => toggleG(k)} />
                                                    <button onClick={() => toggleOpen(k)} className="flex-1 truncate text-left text-dim" title={sub}>{open.has(k) || q ? "v" : ">"} {sub} <span className="text-muted">{list.length}</span></button>
                                                </div>
                                                {(open.has(k) || q) && list.slice(0, 200).map((i) => (
                                                    <div key={i.id} className={`ml-4 flex items-center gap-1 rounded px-1 ${sel === i.id ? "bg-hover text-fg" : "text-dim"}`}>
                                                        {!i.group && <input type="checkbox" checked={!hiddenI.has(i.id)} onChange={() => toggleI(i.id)} />}
                                                        <button className="flex-1 truncate text-left" onClick={() => { setSel(i.id); eng.current?.focus(i) }}>{i.label}</button>
                                                    </div>
                                                ))}
                                                {list.length > 200 && (open.has(k) || q) && <div className="ml-4 text-muted">+{list.length - 200} more (search to narrow)</div>}
                                            </div>
                                        )
                                    })}
                                </div>
                            )
                        })}
                    </div>
                </div>
                <div className="relative min-h-0">
                    <div ref={box} tabIndex={0} className="absolute inset-0 outline-none" />
                    <div className="pointer-events-none absolute bottom-1 left-2 font-mono text-[10px] text-dim">{hud}{it?.pos ? `   | sel ${fmt(it.pos)}` : ""}</div>
                </div>
                <div className="min-h-0 overflow-auto border-l border-line p-2 text-[12px]" data-testid="inspector">
                    <div className="mb-1 font-medium">Inspector</div>
                    {!it ? <div className="text-muted">Select an item in the outliner or the viewport.</div> : (
                        <div>
                            <table className="w-full"><tbody>
                                {([["name", it.label], ["class", it.cls], ["type", it.kind], ["group", `${it.top} / ${it.sub}`], ["position", it.pos ? fmt(it.pos) : it.box ? fmt(centre(it.box)) : "-"], ["rotation (yaw)", it.yaw != null ? `${it.yaw.toFixed(1)} deg` : "-"], ["scale", it.scale != null ? String(it.scale) : "-"], ["bounds min", it.box ? fmt(it.box.min.toArray()) : "-"], ["bounds max", it.box ? fmt(it.box.max.toArray()) : "-"], ["size", it.box ? fmt(it.box.max.clone().sub(it.box.min).toArray()) : "-"], ["triangles", it.tris != null ? String(it.tris) : "-"]] as [string, string][]).map(([k, v]) => <tr key={k}><td className="pr-2 text-muted">{k}</td><td className="break-all tabular-nums">{v}</td></tr>)}
                            </tbody></table>
                            {it.material && <div className="mt-2 flex items-center gap-2"><Thumb eng={eng} name={it.material} /><div><div className="break-all">{it.material}</div><button className="text-sky-300" onClick={() => setHiMat(hiMat === it.material ? null : it.material!)}>highlight all faces</button></div></div>}
                            {it.top === TOP.spawns && <button className="mt-2 rounded border border-line px-2 py-0.5 text-sky-300" onClick={() => eng.current?.fromSpawn(it)}>Go to spawn</button>}
                            <div className="mb-1 mt-3 font-medium">Properties</div>
                            <table className="w-full"><tbody>
                                {Object.entries(it.raw).map(([k, v]) => <tr key={k} className="align-top"><td className="pr-2 text-muted">{k}</td><td className="break-all">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>)}
                                {!Object.keys(it.raw).length && <tr><td className="text-muted">no extra keys in the manifest</td></tr>}
                            </tbody></table>
                        </div>
                    )}
                </div>
            </div>
            <div className="grid border-t border-line text-[12px]" style={{ gridTemplateColumns: "1fr 1fr", maxHeight: 280 }}>
                <div className="overflow-auto border-r border-line p-2" data-testid="materials-panel">
                    <div className="mb-1 font-medium">Materials / textures <span className="text-muted">{ed.materials.length}</span></div>
                    <table className="w-full"><tbody>
                        {ed.materials.map((m) => (
                            <tr key={m.name} onClick={() => { setHiProp(null); setHiMat(hiMat === m.name ? null : m.name) }} className={`cursor-pointer align-middle hover:bg-hover ${hiMat === m.name ? "bg-hover" : ""}`}>
                                <td className="w-8 py-0.5"><Thumb eng={eng} name={m.name} colour={m.colour} /></td>
                                <td className="break-all pr-2">{m.name}</td><td className="tabular-nums text-dim">{m.tris.toLocaleString("en-GB")} tris</td><td className="pl-2 text-dim">{m.surfaces} surf</td>
                                <td className={`pl-2 ${m.textured ? "text-emerald-300" : "text-amber-300"}`}>{m.textured ? "textured" : "no texture"}{m.translucent ? ", translucent" : ""}</td>
                            </tr>
                        ))}
                    </tbody></table>
                </div>
                <div className="overflow-auto p-2" data-testid="props-panel">
                    <div className="mb-1 font-medium">Props / models <span className="text-muted">{ed.props.length}</span></div>
                    <table className="w-full"><tbody>
                        {ed.props.map((p) => (
                            <tr key={p.model} onClick={() => { setHiMat(null); setHiProp(hiProp === p.model ? null : p.model) }} className={`cursor-pointer hover:bg-hover ${hiProp === p.model ? "bg-hover" : ""}`}>
                                <td className="break-all pr-2">{p.model || "(none)"}</td><td className="tabular-nums text-dim">x{p.count}</td><td className="pl-2 text-dim">{p.file || "-"}</td>
                                <td className={`pl-2 ${p.placed ? "text-emerald-300" : "text-amber-300"}`} title={p.reason}>{p.placed ? "placed" : "missing"}</td>
                            </tr>
                        ))}
                    </tbody></table>
                </div>
            </div>
        </div>
    )
}

function Thumb({ eng, name, colour }: { eng: React.RefObject<Eng | null>; name: string; colour?: number[] }) {
    const [src, setSrc] = useState("")
    useEffect(() => { const t = setTimeout(() => setSrc(eng.current?.thumb(name) ?? ""), 400); return () => clearTimeout(t) }, [eng, name])
    return src ? <img src={src} alt="" className="h-7 w-7 rounded border border-line" /> : <span className="inline-block h-7 w-7 rounded border border-line" style={{ background: colour ? hex(colour) : "#333" }} />
}
