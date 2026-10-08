import path from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../../generated/prisma/client'

const file = process.env.NIGHTLY_DB || path.join(process.cwd(), 'data', 'nightly.db')

// In dev the client survives hot reloads. After `prisma generate` (a schema change) the class
// itself is new, and a client of the old one has none of the new models: replace it.
const g = globalThis as unknown as { prisma?: PrismaClient; prismaClass?: unknown }
if (g.prisma && g.prismaClass !== PrismaClient) {
    void g.prisma.$disconnect()
    g.prisma = undefined
}
export const db = g.prisma ?? new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) })
if (process.env.NODE_ENV !== 'production') Object.assign(g, { prisma: db, prismaClass: PrismaClient })
