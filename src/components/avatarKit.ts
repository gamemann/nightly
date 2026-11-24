import type * as T from "three"

export type Avatar = { body: string; glb: string; bones: Record<string, number[]>; mount: number[]; skeleton_in_figure: number[]; swaps?: string[][] }
export type Book = { atlas?: string; height: number; hand_bone: string; held_scale: number; avatars: Avatar[] }
export const AV = "/api/assets/avatar/"
export const plain = (n: string) => n.replace(/\./g, "")
const hex = (h: string) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]

/** The game's people atlas with the look's colours swapped in (GSHumanoidAssets does this in a shader: each from-colour becomes its to-colour). */
export async function recolour(url: string, swaps: string[][]): Promise<HTMLCanvasElement> {
    const img = new Image()
    img.src = url
    await img.decode()
    const cv = document.createElement("canvas")
    cv.width = img.width; cv.height = img.height
    const cx = cv.getContext("2d")!
    cx.drawImage(img, 0, 0)
    const d = cx.getImageData(0, 0, cv.width, cv.height)
    const pairs = swaps.map(([a, b]) => [hex(a), hex(b)])
    for (let i = 0; i < d.data.length; i += 4) {
        for (const [a, b] of pairs) {
            if (Math.abs(d.data[i] - a[0]) + Math.abs(d.data[i + 1] - a[1]) + Math.abs(d.data[i + 2] - a[2]) < 24) {
                d.data[i] = b[0]; d.data[i + 1] = b[1]; d.data[i + 2] = b[2]
                break
            }
        }
    }
    cx.putImageData(d, 0, 0)
    return cv
}


/** A transform stored as 12 floats (basis columns x, y, z, then origin). */
export const mat12 = (THREE: typeof T, a: number[]) => new THREE.Matrix4().makeBasis(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(a[3], a[4], a[5]), new THREE.Vector3(a[6], a[7], a[8])).setPosition(a[9], a[10], a[11])

/** Gives every mesh of a loaded people_<body>.glb the game's atlas with the look's colours swapped in. */
export function texture(THREE: typeof T, root: T.Object3D, cv: HTMLCanvasElement) {
    const tex = new THREE.CanvasTexture(cv)
    tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace
    root.traverse((n) => {
        const m = n as T.Mesh
        if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 })
    })
}

const ARM = /^(UpperArm|LowerArm|Pinky|Middle|Index|Thumb)/
/** Keeps only the triangles the arm and finger bones own (the game shows "only the arms and a little torso"; the torso is dropped here, where it only fills the frame). */
function armsOnly(root: T.Object3D) {
    root.traverse((n) => {
        const m = n as T.SkinnedMesh
        if (!m.isSkinnedMesh) return
        const g = m.geometry, si = g.getAttribute("skinIndex"), sw = g.getAttribute("skinWeight"), ix = g.index
        if (!si || !sw || !ix) return
        const arm = (v: number) => {
            let best = 0, bw = -1
            for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; best = si.getComponent(v, k) } }
            return ARM.test(plain(m.skeleton.bones[best]?.name ?? ""))
        }
        const keep: number[] = []
        for (let i = 0; i < ix.count; i += 3) {
            const a = ix.getX(i), b = ix.getX(i + 1), c = ix.getX(i + 2)
            if (arm(a) && arm(b) && arm(c)) keep.push(a, b, c)
        }
        g.setIndex(keep)
        m.frustumCulled = false
    })
}

const HIDDEN = ["Head", "Neck", "UpperLeg.L", "UpperLeg.R"]
/** GSPlayerViewArms: held_scale, spread (x), and where the eye sits from the head, in the figure's space (gs_player_view_arms_state.gd). */
const HELD = { scale: 0.3, spread: 1.25, eye: [0, 0.18, 0.06], pole: [1, -1.2, 0.5] }

/** Two-bone IK for one arm (UpperArm, LowerArm, Middle1) of a posed figure, as GSPlayerViewArms._reach does with the elbow pole. `world` is the figure's top
 *  node (its matrices are refreshed after each bone move). With `extend` the shoulder moves out toward a target the arm cannot reach (the game's _extend).
 *  The pole is the elbow's direction in world space; null keeps the bend the pose already has. */
export function armSolver(THREE: typeof T, bones: Map<string, T.Bone>, world: T.Object3D, extend: boolean) {
    const chain = (side: "R" | "L") => ["UpperArm", "LowerArm", "Middle1"].map((n) => bones.get(`${n}${side}`))
    const pos = (o: T.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld)
    const wq = (o: T.Object3D) => o.getWorldQuaternion(new THREE.Quaternion())
    const setWorldQ = (b: T.Bone, q: T.Quaternion) => { b.quaternion.copy(wq(b.parent!).invert().multiply(q)); b.updateWorldMatrix(false, true) }
    const bind = new Map<T.Bone, T.Quaternion>()
    const bindPos = new Map<T.Bone, T.Vector3>()
    for (const c of [chain("R"), chain("L")]) for (const b of c) if (b) { bind.set(b, b.quaternion.clone()); bindPos.set(b, b.position.clone()) }
    return (side: "R" | "L", target: T.Vector3, pole: T.Vector3 | null) => {
        const [u, l, w] = chain(side)
        if (!u || !l || !w) return
        for (const b of [u, l]) b.quaternion.copy(bind.get(b)!)
        u.position.copy(bindPos.get(u)!)
        world.updateMatrixWorld(true)
        let U = pos(u)
        const L0 = pos(l), W0 = pos(w)
        if (!pole) { const mid = U.clone().add(W0).multiplyScalar(0.5); pole = L0.clone().sub(mid); if (pole.lengthSq() < 1e-8) pole = new THREE.Vector3(0, -1, 0) }
        const short = target.distanceTo(U) - (L0.distanceTo(U) + W0.distanceTo(L0))
        if (extend && short > 0) {
            const inv = new THREE.Matrix4().copy(u.parent!.matrixWorld).invert()
            const moved = U.clone().add(target.clone().sub(U).normalize().multiplyScalar(short))
            u.position.add(moved.applyMatrix4(inv).sub(U.clone().applyMatrix4(inv)))
            world.updateMatrixWorld(true)
            U = pos(u)
        }
        const L = pos(l), W = pos(w)
        const a = L.clone().sub(U), b = W.clone().sub(L)
        const la = a.length(), lb = b.length(), to = target.clone().sub(U)
        if (la < 1e-4 || lb < 1e-4 || to.length() < 1e-4) return
        const reach = Math.min(Math.max(to.length(), Math.abs(la - lb) + 0.001), la + lb - 0.001)
        const dir = to.clone().normalize()
        const along = (la * la - lb * lb + reach * reach) / (2 * reach)
        const height = Math.sqrt(Math.max(la * la - along * along, 0))
        let sideV = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)))
        sideV = sideV.lengthSq() > 1e-6 ? sideV.normalize() : new THREE.Vector3(0, 1, 0)
        const elbow = U.clone().add(dir.clone().multiplyScalar(along)).add(sideV.multiplyScalar(height))
        const goal = U.clone().add(dir.clone().multiplyScalar(reach))
        const q1 = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), elbow.clone().sub(U).normalize())
        setWorldQ(u, q1.clone().multiply(wq(u)))
        world.updateMatrixWorld(true)
        const b2 = pos(w).sub(pos(l))
        const q2 = new THREE.Quaternion().setFromUnitVectors(b2.normalize(), goal.clone().sub(pos(l)).normalize())
        setWorldQ(l, q2.multiply(wq(l)))
    }
}

export type ViewArms = { solve: (right: T.Vector3 | null, left: T.Vector3 | null) => void }

/** The game's first-person arms: the people figure itself, head / neck / legs hidden, scaled and offset so the eye sits where the game puts it
 *  (GSPlayerViewArms._fit), and each arm solved by two-bone IK (UpperArm, LowerArm, Middle1) to the wrist target, as _reach does with the elbow pole.
 *  Fingers keep the pose's curl (the game's hand-pose layer is not reproduced). `parent` is the lens rig; targets are in its space. */
export function buildViewArms(THREE: typeof T, root: T.Object3D, av: Avatar, parent: T.Object3D): ViewArms {
    const bones = new Map<string, T.Bone>()
    root.traverse((n) => { if ((n as T.Bone).isBone) bones.set(plain(n.name), n as T.Bone) })
    for (const [name, v] of Object.entries(av.bones)) {
        const b = bones.get(plain(name))
        if (b && v.length >= 10) { b.position.set(v[0], v[1], v[2]); b.quaternion.set(v[3], v[4], v[5], v[6]); b.scale.set(v[7], v[8], v[9]) }
    }
    for (const h of HIDDEN) bones.get(plain(h))?.scale.setScalar(0.0001)
    armsOnly(root)
    // the figure: the skeleton node lands where the game's figure has it, then the fit
    root.updateMatrixWorld(true)
    const head = bones.get("Head")
    const skel = ((): T.Object3D => { let n: T.Object3D = head ?? root; while (n.parent && (n.parent as T.Bone).isBone) n = n.parent; return n.parent ?? n })()
    const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(skel.matrixWorld)
    root.matrixAutoUpdate = false
    root.matrix.copy(mat12(THREE, av.skeleton_in_figure)).multiply(rel.invert())
    root.updateMatrixWorld(true)
    const headFig = head ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld) : new THREE.Vector3()
    const S = new THREE.Matrix4().makeScale(HELD.scale * HELD.spread, HELD.scale, HELD.scale)
    const eyeV = new THREE.Vector3(...HELD.eye)
    const fig = new THREE.Group()
    fig.matrixAutoUpdate = false
    fig.matrix.copy(S).setPosition(headFig.clone().applyMatrix4(S).add(eyeV).negate())
    fig.add(root)
    parent.add(fig)
    const solveArm = armSolver(THREE, bones, fig, true)
    // the weapon-side targets arrive in the lens rig's space; the solve runs in the world (the figure sits in the rig)
    return {
        solve: (right, left) => {
            parent.updateMatrixWorld(true)
            const p = new THREE.Vector3(...HELD.pole).transformDirection(fig.matrixWorld).normalize()
            if (right) solveArm("R", right.clone().applyMatrix4(parent.matrixWorld), p)
            if (left) solveArm("L", left.clone().applyMatrix4(parent.matrixWorld), new THREE.Vector3(-HELD.pole[0], HELD.pole[1], HELD.pole[2]).transformDirection(fig.matrixWorld).normalize())
        },
    }
}
