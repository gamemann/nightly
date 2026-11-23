import { ClientTabs } from '~/components/shell/ClientTabs'
import { ASSET_TABS } from '~/lib/nav'

/** The Asset Manager: assets, RSI findings, reviews/QA and content share one tab strip. */
export default function AssetManagerLayout({ children }: { children: React.ReactNode }) {
    return <><ClientTabs tabs={ASSET_TABS} />{children}</>
}
