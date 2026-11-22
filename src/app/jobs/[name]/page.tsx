import { Prompts } from '~/components/Prompts'

export default async function JobPage({ params }: { params: Promise<{ name: string }> }) {
    return <Prompts kind="script" name={decodeURIComponent((await params).name)} />
}
