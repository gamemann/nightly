import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'
import { db } from './db'

export const createContext = async () => ({ db })

const t = initTRPC.context<typeof createContext>().create({
    transformer: superjson,
    errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: { ...shape.data, zodError: error.cause instanceof ZodError ? error.cause.flatten() : null },
    }),
})

export const router = t.router
export const procedure = t.procedure
