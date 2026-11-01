"use client"
import { useEffect, useRef, useState } from "react"
import type { Pin } from "./PictureViewer"

type Hit = { x: number; y: number; z: number; nx: number; ny: number; nz: number }

/** Orbit / zoom a .glb or .gltf. A click (not a drag) on the surface reports the 3D point and normal; pins are sprites. */
export function ModelViewer({ url, pins, selected, onPlace, onSelect }: {
    url: string; pins: Pin[]; selected: number | null; onPlace: (h: Hit) => void; onSelect: (id: number) => void
}) {
    const host = useRef<HTMLDivElement | null>(null)
    const [state, setState] = useState<"loading" | "ready" | "error">("loading")
    const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
    const api = useRef<{ setPins: (p: Pin[], sel: number | null) => void } | null>(null)
    const cb = useRef({ onPlace, onSelect })
    cb.current = { onPlace, onSelect }

    useEffect(() => {
        const el = host.current
        if (!el) return
        let dead = false
        let cleanup = () => {}
        void (async () => {
            const THREE = await import("three")
            const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
            const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js")
            if (dead) return
            const renderer = new THREE.WebGLRenderer({ antialias: true })
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
            el.appendChild(renderer.domElement)
            const scene = new THREE.Scene()
            scene.background = new THREE.Color(0x15161a)
            scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6))
            const sun = new THREE.DirectionalLight(0xffffff, 2)
            sun.position.set(3, 5, 4)
            scene.add(sun)
            const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
            const controls = new OrbitControls(camera, renderer.domElement)
            controls.enableDamping = true
            const pinGroup = new THREE.Group()
            scene.add(pinGroup)
            let root: import("three").Object3D | null = null
            let size = 1
            let sprites: { s: import("three").Sprite; pin: Pin }[] = []
            const tex = new Map<string, import("three").CanvasTexture>()
            const label = (n: number, sel: boolean) => {
                const k = `${n}${sel}`
                let t = tex.get(k)
                if (!t) {
                    const c = document.createElement("canvas")
                    c.width = c.height = 64
                    const g = c.getContext("2d")!
                    g.fillStyle = sel ? "#f59e0b" : "#8b8cf8"
                    g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill()
                    g.lineWidth = 4; g.strokeStyle = "#fff"; g.stroke()
                    g.fillStyle = "#fff"; g.font = "bold 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"
                    g.fillText(String(n), 32, 34)
                    t = new THREE.CanvasTexture(c)
                    tex.set(k, t)
                }
                return t
            }
            api.current = {
                setPins: (list, sel) => {
                    for (const o of sprites) { pinGroup.remove(o.s); o.s.material.dispose() }
                    sprites = list.map((pin, i) => {
                        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(i + 1, pin.id === sel), depthTest: false, transparent: true }))
                        s.scale.setScalar(size * 0.06)
                        s.position.set(pin.x + pin.nx * size * 0.01, pin.y + pin.ny * size * 0.01, pin.z + pin.nz * size * 0.01)
                        s.renderOrder = 10
                        pinGroup.add(s)
                        return { s, pin }
                    })
                },
            }
            const resize = () => {
                const w = el.clientWidth, h = el.clientHeight
                renderer.setSize(w, h)
                camera.aspect = w / Math.max(h, 1)
                camera.updateProjectionMatrix()
            }
            const ro = new ResizeObserver(resize)
            ro.observe(el)
            resize()
            new GLTFLoader().load(url, (gltf) => {
                if (dead) return
                root = gltf.scene
                scene.add(root)
                const box = new THREE.Box3().setFromObject(root)
                const sphere = box.getBoundingSphere(new THREE.Sphere())
                size = Math.max(sphere.radius * 2, 0.001)
                camera.near = size / 1000; camera.far = size * 100
                camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(size * 1.4))
                camera.updateProjectionMatrix()
                controls.target.copy(sphere.center)
                controls.update()
                setState("ready")
                api.current?.setPins(lastPins.current.pins, lastPins.current.sel)
            }, undefined, () => !dead && setState("error"))

            const ray = new THREE.Raycaster()
            const ndc = (e: PointerEvent | MouseEvent) => {
                const r = renderer.domElement.getBoundingClientRect()
                ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
            }
            const pinAt = (e: PointerEvent) => {
                ndc(e)
                const hits = ray.intersectObjects(sprites.map((o) => o.s), false)
                return hits.length ? sprites.find((o) => o.s === hits[0].object)?.pin : undefined
            }
            let down: { x: number; y: number } | null = null
            const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY } }
            const onUp = (e: PointerEvent) => {
                if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !root) return
                down = null
                const p = pinAt(e)
                if (p) return cb.current.onSelect(p.id)
                ndc(e)
                const hit = ray.intersectObject(root, true).find((h) => h.face)
                if (!hit || !hit.face) return
                const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
                cb.current.onPlace({ x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: n.x, ny: n.y, nz: n.z })
            }
            const onMove = (e: PointerEvent) => {
                const p = pinAt(e)
                const r = el.getBoundingClientRect()
                setTip((t) => (p ? { text: p.text, x: e.clientX - r.left + 12, y: e.clientY - r.top + 12 } : t ? null : t))
            }
            const dom = renderer.domElement
            dom.addEventListener("pointerdown", onDown); dom.addEventListener("pointerup", onUp); dom.addEventListener("pointermove", onMove)
            let raf = 0
            const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera) }
            loop()
            cleanup = () => {
                cancelAnimationFrame(raf); ro.disconnect()
                dom.removeEventListener("pointerdown", onDown); dom.removeEventListener("pointerup", onUp); dom.removeEventListener("pointermove", onMove)
                controls.dispose()
                scene.traverse((o) => {
                    const m = o as import("three").Mesh
                    m.geometry?.dispose()
                    const mat = m.material as import("three").Material | import("three").Material[] | undefined
                    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) x.dispose()
                })
                tex.forEach((t) => t.dispose())
                renderer.dispose()
                dom.remove()
                api.current = null
            }
        })()
        return () => { dead = true; cleanup() }
    }, [url])

    const lastPins = useRef({ pins, sel: selected })
    lastPins.current = { pins, sel: selected }
    useEffect(() => { api.current?.setPins(pins, selected) }, [pins, selected])

    return (
        <div ref={host} className="relative h-full min-h-[50vh] w-full overflow-hidden rounded bg-black">
            {state !== "ready" && <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">{state === "loading" ? "Loading model…" : "Could not load the model."}</div>}
            {tip && <div className="pointer-events-none absolute z-10 max-w-xs rounded bg-black/85 px-2 py-1 text-[12px] text-white" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
            <div className="pointer-events-none absolute bottom-1.5 left-2 text-[11px] text-white/50">drag to orbit · wheel to zoom · right-drag to pan · click the surface to pin a note</div>
        </div>
    )
}
