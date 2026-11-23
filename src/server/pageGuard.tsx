import type { ReactNode } from 'react'
import { NoAccess } from '~/components/shell/ui'
import { allowed } from '~/lib/nav'
import { getViewer, type Viewer } from './auth'

/**
 * Server pages that read the database directly (not through tRPC) start with
 *   const no = await guard('tools.view'); if (no) return no
 * It returns the No-access panel when the viewer lacks any of the keys, else null.
 * The proxy has already made sure someone is signed in.
 */
export async function guard(perm: string | string[]): Promise<ReactNode | null> {
    const v = await getViewer()
    return v && allowed(v.perms, perm) ? null : <NoAccess perm={perm} />
}

/** The viewer, or the No-access panel; for pages that also need the viewer. */
export async function guarded(perm: string | string[]): Promise<{ viewer: Viewer; no: null } | { viewer: null; no: ReactNode }> {
    const v = await getViewer()
    return v && allowed(v.perms, perm) ? { viewer: v, no: null } : { viewer: null, no: <NoAccess perm={perm} /> }
}
