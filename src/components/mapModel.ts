import type * as T from "three"

/** Editor model of a converted map: the outliner items, built from the GLB node extras and the scene extras (extras.map.editor)
 *  written by lib/map-glb.mjs, so nothing is re-parsed from manifests. */
export type Item = {
    id: number; top: string; sub: string; label: string; cls: string; kind: string
    obj?: T.Object3D          // the scene node (world chunk, prop) or a client-made marker
    group?: string            // aggregate overlay this item belongs to (its visibility follows the group)
    box?: T.Box3              // bounds (metres) for focus and selection outline
    pos?: number[]; yaw?: number; scale?: number; tris?: number; material?: string
    raw: Record<string, unknown>
}
export type MatInfo = { name: string; tris: number; surfaces: number; textured: boolean; translucent: boolean; colour: number[]; albedo: string; normal: string }
export type PropInfo = { model: string; file: string; count: number; placed: boolean; size: number; reason: string }
export type Editor = {
    info: Record<string, unknown>; spawns: { x: number; y: number; z: number; yaw: number; team: string }[]
    triggers: { kind: string; min: number[]; max: number[]; raw: Record<string, unknown> }[]
    hulls: { kind: string; points: number; min?: number[]; max?: number[]; planes?: number }[]
    points: { class: string; kind: string; name: string; at: number[]; yaw?: number; raw: Record<string, unknown> }[]
    props: PropInfo[]; materials: MatInfo[]; hullKinds: Record<string, number>
}
export const TOP = { world: "World geometry", props: "Props", hulls: "Collision hulls", triggers: "Triggers", spawns: "Spawn points", entities: "Entities" } as const
export const EMPTY: Editor = { info: {}, spawns: [], triggers: [], hulls: [], points: [], props: [], materials: [], hullKinds: {} }

const box = (THREE: typeof T, min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
const COL: Record<string, number> = { control_point: 0xffd24a, flag_spawn: 0xff7a3a, pickup: 0x5ad1ff, sound: 0x9a7bff, light: 0xfff6a0, entity: 0xc0c4cc, zone_point: 0xff5cc8 }
const TEAM: Record<string, number> = { red: 0xff5a5a, blue: 0x5a8aff }

/** Items for the outliner: scene nodes with extras plus markers/boxes made from the editor lists. `markers` is added to the scene by the caller. */
export function buildItems(THREE: typeof T, root: T.Object3D, ed: Editor): { items: Item[]; markers: T.Group } {
    const items: Item[] = []
    const add = (it: Omit<Item, "id">) => { const r = { ...it, id: items.length }; items.push(r); return r }
    const markers = new THREE.Group()
    const nodeBox = (o: T.Object3D) => new THREE.Box3().setFromObject(o)
    const hullAgg = new Map<string, T.Object3D>(), trigAgg = new Map<string, T.Object3D>()
    for (const o of root.children) {
        const x = (o.userData ?? {}) as Record<string, unknown>
        const cls = x.class as string | undefined
        if (!cls) continue
        if (cls === "brush") add({ top: TOP.world, sub: String(x.material || "(no material)"), label: `${o.name.replace(/^world_/, "chunk ")}`, cls, kind: String(x.kind), obj: o, box: nodeBox(o), tris: Number(x.tris) || 0, material: String(x.material ?? ""), raw: (x.raw as Record<string, unknown>) ?? {} })
        else if (cls === "prop") {
            const placed = !!x.placed
            const p = o.position
            add({ top: TOP.props, sub: `${String(x.model || "(none)")}${placed ? "" : "  [missing]"}`, label: o.name, cls: "prop", kind: String(x.kind), obj: o, box: nodeBox(o), pos: [p.x, p.y, p.z], yaw: Number(x.yaw) || 0, scale: Number(x.scale) || 1, raw: { model: x.model, file: x.file, placed, size: x.size, ...((x.raw as object) ?? {}) } })
        } else if (cls === "hull") hullAgg.set(String(x.kind), o)
        else if (cls === "trigger") trigAgg.set(String(x.kind), o)
    }
    ed.hulls.forEach((h, i) => { if (h.min && h.max) add({ top: TOP.hulls, sub: h.kind, label: `hull ${i}`, cls: "hull", kind: h.kind, group: `hull:${h.kind}`, box: box(THREE, h.min, h.max), raw: { points: h.points, planes: h.planes } }) })
    ed.triggers.forEach((z, i) => add({ top: TOP.triggers, sub: z.kind, label: `${z.kind} ${i}`, cls: "trigger", kind: z.kind, group: `trigger:${z.kind}`, box: box(THREE, z.min, z.max), raw: z.raw }))
    const marker = (it: Omit<Item, "id" | "obj">, at: number[], colour: number, tall: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, tall, 0.5), new THREE.MeshBasicMaterial({ color: colour }))
        m.position.set(at[0], at[1] + tall / 2, at[2]); markers.add(m)
        add({ ...it, obj: m, pos: at, box: new THREE.Box3().setFromObject(m) })
    }
    ed.spawns.forEach((s, i) => marker({ top: TOP.spawns, sub: s.team || "any", label: `spawn ${i}`, cls: "spawn", kind: s.team || "any", yaw: s.yaw, raw: { team: s.team, yaw: s.yaw } }, [s.x, s.y, s.z], TEAM[s.team] ?? 0x4dff7a, 1.8))
    ed.points.forEach((p) => marker({ top: TOP.entities, sub: p.class === "entity" ? p.kind : p.class, label: p.name || p.kind, cls: p.class, kind: p.kind, yaw: p.yaw, raw: p.raw }, p.at, COL[p.class] ?? COL.entity, 1.2))
    return { items, markers: Object.assign(markers, { userData: { hullAgg, trigAgg } }) }
}

/** The aggregate overlay mesh of a group id (`hull:<kind>` / `trigger:<kind>`). */
export const aggOf = (markers: T.Group, g: string): T.Object3D | undefined => {
    const u = markers.userData as { hullAgg: Map<string, T.Object3D>; trigAgg: Map<string, T.Object3D> }
    return g.startsWith("hull:") ? u.hullAgg.get(g.slice(5)) : u.trigAgg.get(g.slice(8))
}
