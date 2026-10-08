import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A report's `![..](screenshots/<date>/x.png)` points into the media dir, served at /media/.
const url = (u: string) => (u.startsWith('screenshots/') ? `/media/${u.slice('screenshots/'.length)}` : defaultUrlTransform(u))

export function Markdown({ children }: { children: string }) {
    return (
        <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url}>{children}</ReactMarkdown>
        </div>
    )
}
