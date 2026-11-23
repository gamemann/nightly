export type NodeDesc = { id: number; name: string; host: string; port: number; tls: boolean; token: string; enabled?: boolean; conn?: { fingerprint?: string; ca?: string; tlsVerify?: boolean } }
export type NodeStatus = { id: number; name: string; state: 'offline' | 'connecting' | 'online' | 'denied'; error: string; lastSeen: string | null; live: any; version: string }
export class NodeManager {
    constructor(opts?: { clientName?: string; handlers?: Record<string, (args: any) => any>; minDelay?: number; maxDelay?: number })
    sync(descs: NodeDesc[]): void
    statuses(): NodeStatus[]
    request(id: number, op: string, args?: any, ms?: number): Promise<any>
    on(ev: 'status', fn: (s: NodeStatus) => void): this
    on(ev: 'event', fn: (ev: string, data: any, desc: NodeDesc) => void): this
    stopAll(): void
}
