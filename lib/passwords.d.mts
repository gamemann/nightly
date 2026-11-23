export const MIN_PASSWORD: number
export function hashPassword(password: string): string
export function verifyPassword(password: string, stored: string): boolean
export function sha256(s: string): string
export function newToken(bytes?: number): string
export function randomPassword(): string
export function safeEqual(a: string, b: string): boolean
export const USERNAME: RegExp
export function checkUsername(u: string): string
