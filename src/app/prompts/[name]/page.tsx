import { Prompts } from '~/components/Prompts'

export default async function PromptPage({ params }: { params: Promise<{ name: string }> }) {
    return <Prompts name={decodeURIComponent((await params).name)} />
}
