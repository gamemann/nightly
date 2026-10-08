'use client'
import type { KeyboardEvent, TextareaHTMLAttributes } from 'react'

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    value: string
    onValueChange: (v: string) => void
}

const LIST = /^([\t ]*)([-*+]|(\d+)([.)]))([\t ]+)(\[[ xX]\][\t ]+)?/

// A plain textarea that knows a little Markdown: Tab indents instead of leaving the box, Shift+Tab outdents,
// Enter continues a list (and ends it on an empty item), Ctrl+B / Ctrl+I wrap the selection. Esc leaves the box,
// because once Tab is taken there is otherwise no keyboard way out.
export function MarkdownEditor({ value, onValueChange, onKeyDown, className = '', ...rest }: Props) {
    const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || e.nativeEvent.isComposing) return
        const ta = e.currentTarget
        const { selectionStart: s, selectionEnd: t, value: v } = ta
        const mod = e.ctrlKey || e.metaKey

        if (e.key === 'Escape') { ta.blur(); return }

        if (e.key === 'Tab' && !mod && !e.altKey) {
            e.preventDefault()
            const multi = v.slice(s, t).includes('\n')
            if (!e.shiftKey && !multi) return edit(ta, s, t, '\t')
            // Indent or outdent every line the selection touches. A selection ending at the very start of a line
            // (what a triple-click or a Shift+Down leaves) does not include that line.
            const ls = v.lastIndexOf('\n', s - 1) + 1
            const endFrom = t > s && v[t - 1] === '\n' ? t - 1 : t
            const le = v.indexOf('\n', endFrom) === -1 ? v.length : v.indexOf('\n', endFrom)
            const lines = v.slice(ls, le).split('\n')
            const out = lines.map((l) => (e.shiftKey ? l.replace(/^(\t| {1,4})/, '') : `\t${l}`))
            const block = out.join('\n')
            if (block === v.slice(ls, le)) return
            if (multi) return edit(ta, ls, le, block, ls, ls + block.length)
            const d = out[0].length - lines[0].length
            return edit(ta, ls, le, block, Math.max(ls, s + d), Math.max(ls, t + d))
        }

        if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && s === t) {
            const ls = v.lastIndexOf('\n', s - 1) + 1
            const le = v.indexOf('\n', s) === -1 ? v.length : v.indexOf('\n', s)
            const before = v.slice(ls, s)
            const m = LIST.exec(before)
            if (m) {
                e.preventDefault()
                // Enter on an item with nothing in it ends the list, the way every Markdown editor does.
                if (before.length === m[0].length && !v.slice(s, le).trim()) return edit(ta, ls, s, '')
                const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]
                return edit(ta, s, s, `\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`)
            }
            // Keep the indentation of an indented line (code, nested paragraphs); a blank indented line falls through.
            const indent = /^[\t ]+/.exec(before)?.[0]
            if (indent && before.trim()) {
                e.preventDefault()
                return edit(ta, s, s, `\n${indent}`)
            }
        }

        if (mod && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
            e.preventDefault()
            const w = e.key === 'b' ? '**' : '_'
            const sel = v.slice(s, t)
            return edit(ta, s, t, `${w}${sel}${w}`, s + w.length, t + w.length)
        }
    }

    return (
        <textarea {...rest} value={value} onChange={(e) => onValueChange(e.target.value)} onKeyDown={handleKey}
            spellCheck={rest.spellCheck ?? true} className={`md-editor ${className}`} />
    )
}

// Replace [start, end) with `text` through execCommand, because it is the only edit to a textarea that lands on the
// browser's own undo stack -- assigning .value or calling setRangeText makes Ctrl+Z skip straight past it. It is
// deprecated but still implemented everywhere; the fallback keeps the edit working without undo if it ever goes.
function edit(ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart?: number, selEnd?: number) {
    ta.focus()
    ta.setSelectionRange(start, end)
    let ok = false
    try {
        ok = start === end && !text ? true : document.execCommand(text ? 'insertText' : 'delete', false, text)
    } catch {}
    if (!ok) {
        ta.setRangeText(text, start, end, 'end')
        // React tracks the last value it set, so a native input event is enough for onChange to fire.
        ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart)
}
