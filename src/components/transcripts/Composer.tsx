'use client'
import { useState } from 'react'
import { EFFORTS, MODELS, MODES } from './types'

export type Opts = { model: string; effort: string; mode: string }
export const DEFAULT_OPTS: Opts = { model: '', effort: '', mode: 'default' }

export function Pickers({ opts, set }: { opts: Opts; set: (o: Opts) => void }) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <select className="select !w-auto !py-0.5 text-[12px]" title="Model" value={opts.model} onChange={(e) => set({ ...opts, model: e.target.value })}>
                {MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className="select !w-auto !py-0.5 text-[12px]" title="Reasoning effort" value={opts.effort} onChange={(e) => set({ ...opts, effort: e.target.value })}>
                <option value="">Effort: default</option>
                {EFFORTS.map((v) => <option key={v} value={v}>Effort: {v}</option>)}
            </select>
            <select className="select !w-auto !py-0.5 text-[12px]" title={MODES.find((m) => m[0] === opts.mode)?.[2]} value={opts.mode} onChange={(e) => set({ ...opts, mode: e.target.value })}>
                {MODES.map(([v, l, d]) => <option key={v} value={v} title={d}>{l}</option>)}
            </select>
        </div>
    )
}

export function Composer({ opts, setOpts, busy, disabled, hint, onSend, onInterrupt, onStop, placeholder }: {
    opts: Opts; setOpts: (o: Opts) => void; busy?: boolean; disabled?: boolean; hint?: string
    onSend: (text: string) => void | Promise<void>; onInterrupt?: () => void; onStop?: () => void; placeholder?: string
}) {
    const [text, setText] = useState('')
    const go = async () => {
        const t = text.trim()
        if (!t || disabled) return
        setText('')
        await onSend(t)
    }
    return (
        <div className="border-t border-line bg-panel p-3">
            <div className="mx-auto max-w-4xl">
                <textarea
                    className="input min-h-[72px] w-full resize-y font-sans text-[13px]" value={text} disabled={disabled}
                    placeholder={placeholder ?? 'Message Claude. Enter sends, Shift+Enter adds a line'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void go() } }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Pickers opts={opts} set={setOpts} />
                    {hint && <span className="text-[11px] text-muted">{hint}</span>}
                    <span className="flex-1" />
                    {busy && onInterrupt && <button className="btn" onClick={onInterrupt} title="Interrupt the current turn; the session stays open">Interrupt</button>}
                    {busy && onStop && <button className="btn" onClick={onStop} title="End the run">Stop</button>}
                    <button className="btn btn-primary" disabled={disabled || !text.trim()} onClick={() => void go()}>{busy ? 'Queue' : 'Send'}</button>
                </div>
            </div>
        </div>
    )
}
