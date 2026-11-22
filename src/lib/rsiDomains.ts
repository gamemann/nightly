/** The RSI domains and texture tiers (client-safe: no database import). */
export const DOMAINS = ["perf", "models", "textures", "animations", "sounds", "maps", "visual", "netchaos", "web", "content"] as const
export type Domain = (typeof DOMAINS)[number]
export const TIERS = ["low", "medium", "high"] as const
