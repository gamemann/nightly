export type Cron = {
    minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>
    domAny: boolean; dowAny: boolean
}
export function parseCron(expr: string): Cron
export function cronMatches(expr: string | Cron, date?: Date): boolean
export function nextFires(expr: string | Cron, from?: Date, n?: number): Date[]
export function cronError(expr: string): string | null
