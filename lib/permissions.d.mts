export type Permission = { key: string; area: string; label: string }
export type Perms = { allow: string[]; deny: string[] }
export type AccessRow = { projectId: number | null; folderId: number | null; userId: number | null; roleId: number | null; perms: string }
export type ProjectScope = {
    userId: number; roleIds: number[]; access: AccessRow[]
    projectFolder: Map<number, number | null>; parents: Map<number, number | null>
}
export type TreeFolder<F> = F & { children: TreeFolder<F>[] }
export const PERMISSIONS: Permission[]
export const PERMISSION_KEYS: string[]
export const DEFAULT_ROLES: Record<string, { description: string; grants: string[] }>
export function validGrant(pattern: string): boolean
export function matchPerm(pattern: string, key: string): boolean
export function resolvePerms(roleGrants?: string[], userGrants?: { perm: string; allow: boolean | number }[]): Perms
export function can(perms: Perms | null | undefined, key: string): boolean
export function isAdmin(perms: Perms | null | undefined): boolean
export function ancestors(folderId: number | null, parents: Map<number, number | null>): number[]
export function wouldCycle(folderId: number, parentId: number | null, parents: Map<number, number | null>): boolean
export function projectGrants(scope: ProjectScope, projectId: number): string[]
export function canProject(perms: Perms | null | undefined, scope: ProjectScope, key: string, projectId: number): boolean
export function folderTree<F extends { id: number; parentId: number | null; name: string; sort?: number }>(folders: F[]): TreeFolder<F>[]
export function flattenTree<F extends { name: string }>(tree: TreeFolder<F>[], depth?: number, path?: string[]): { folder: TreeFolder<F>; depth: number; path: string[] }[]
