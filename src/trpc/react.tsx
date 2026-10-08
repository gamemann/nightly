'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCReact } from '@trpc/react-query'
import { useState } from 'react'
import superjson from 'superjson'
import type { AppRouter } from '~/server/api'

export const api = createTRPCReact<AppRouter>()
export type RouterOutputs = inferRouterOutputs<AppRouter>

export function TRPCProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(
        () => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } } }),
    )
    const [client] = useState(() =>
        api.createClient({ links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })] }),
    )
    return (
        <api.Provider client={client} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </api.Provider>
    )
}
