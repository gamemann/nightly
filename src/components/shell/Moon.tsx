/** Nightly's moon mark. */
export function Moon({ className = 'size-6' }: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" className={className} aria-hidden>
            <defs>
                <radialGradient id="moon-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#8b8cf8" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#8b8cf8" stopOpacity="0" />
                </radialGradient>
            </defs>
            <circle cx="16" cy="16" r="15" fill="url(#moon-glow)" />
            <path d="M20.5 7.5a9 9 0 1 0 4 13.2A7.2 7.2 0 0 1 20.5 7.5Z" fill="#8b8cf8" />
        </svg>
    )
}
