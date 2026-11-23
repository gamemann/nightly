import { AccountSettings } from '~/components/account/AccountSettings'

// Every signed-in user sees their own account; editing name and password needs account.edit.
export default function AccountSettingsPage() {
    return <AccountSettings />
}
