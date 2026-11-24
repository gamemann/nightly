import type * as T from "three"
import type { Mounted } from "./AssetViewer"

/** Keeps `parent`'s attachment children equal to `list` (glb at the weapon-space transform; rotation in degrees). Shared by the view model and third-person modes. */
export function syncMounts(THREE: typeof T, load: (url: string) => Promise<T.Object3D>, parent: T.Object3D, list: Mounted[], isDead: () => boolean) {
    const want = new Map(list.map((m) => [m.key, m]))
    for (const ch of [...parent.children]) if (ch.name.startsWith("attachment_") && !want.has(ch.name.slice(11))) parent.remove(ch)
    for (const m of list) {
        if (parent.getObjectByName(`attachment_${m.key}`)) continue
        void load(m.url).then((src) => {
            if (isDead() || parent.getObjectByName(`attachment_${m.key}`)) return
            const ob = src.clone(true), d = Math.PI / 180
            ob.position.set(m.pos[0] ?? 0, m.pos[1] ?? 0, m.pos[2] ?? 0)
            ob.rotation.set((m.rot[0] ?? 0) * d, (m.rot[1] ?? 0) * d, (m.rot[2] ?? 0) * d)
            ob.scale.set(m.scale[0] ?? 1, m.scale[1] ?? 1, m.scale[2] ?? 1)
            ob.name = `attachment_${m.key}`
            parent.add(ob)
        }, () => {})
    }
    void THREE
}
