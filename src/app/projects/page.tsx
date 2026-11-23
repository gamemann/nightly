import { Suspense } from 'react'
import { Projects } from '~/components/projects/Projects'

// Every signed-in user may open the list; project.list returns only the projects they may see.
export default function ProjectsPage() {
    return <Suspense><Projects /></Suspense>
}
