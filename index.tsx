/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 philosolog
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/index";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu, Popout, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Yomitan as PluginNative<typeof import("./native")>;

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

async function runNativeAction(action: () => Promise<string | null>, failurePrefix: string, success: string) {
    const error = await action();
    showToast(error ? `${failurePrefix}: ${error}` : success, error ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
}

function LanguageIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8ZM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96ZM4.26 14a7.94 7.94 0 0 1 0-4h3.38a16.6 16.6 0 0 0 0 4H4.26Zm.81 2h2.95c.35 1.25.8 2.45 1.38 3.56A8.03 8.03 0 0 1 5.07 16Zm2.95-8H5.07a8.03 8.03 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.02 8ZM12 19.96a15.6 15.6 0 0 1-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96ZM14.59 14H9.41a14.6 14.6 0 0 1 0-4h5.18a14.6 14.6 0 0 1 0 4Zm.03 5.56c.58-1.11 1.03-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56ZM16.36 14a16.6 16.6 0 0 0 0-4h3.38a7.94 7.94 0 0 1 0 4h-3.38Z"
            />
        </svg>
    );
}

function LanguageMenu({ closePopout }: { closePopout: () => void; }) {
    const [profiles, setProfiles] = useState<string[] | null>(null);
    const [current, setCurrent] = useState<number | null>(null);

    useEffect(() => {
        Native.listYomitanProfiles().then(result => {
            setProfiles(result.profiles);
            setCurrent(result.current);
        }).catch(() => {
            setProfiles([]);
            showToast("Failed to load Yomitan profiles", Toasts.Type.FAILURE);
        });
    }, []);

    return (
        <Menu.Menu navId="vc-yomitan-language-menu" onClose={closePopout}>
            {profiles === null ? (
                <Menu.MenuItem id="vc-yomitan-loading" label="Loading..." disabled />
            ) : profiles.length === 0 ? (
                <Menu.MenuItem id="vc-yomitan-none" label="No Yomitan profiles found" disabled />
            ) : (
                profiles.map((name, index) => (
                    <Menu.MenuRadioItem
                        key={index}
                        group="vc-yomitan-profile"
                        id={`vc-yomitan-profile-${index}`}
                        label={name}
                        checked={index === current}
                        action={async () => {
                            setCurrent(index);
                            const error = await Native.switchYomitanProfile(index);
                            if (error) {
                                showToast(`Failed to switch Yomitan profile: ${error}`, Toasts.Type.FAILURE);
                            } else {
                                showToast(`Switched Yomitan profile to ${name}`, Toasts.Type.SUCCESS);
                            }
                        }}
                    />
                ))
            )}
        </Menu.Menu>
    );
}

function YomitanLanguageButton() {
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    return (
        <Popout
            position="top"
            align="left"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <LanguageMenu closePopout={closePopout} />}
        >
            {popoutProps => (
                <PanelButton
                    {...popoutProps}
                    ref={buttonRef}
                    tooltipText="Switch Yomitan Language"
                    icon={LanguageIcon}
                    role="button"
                />
            )}
        </Popout>
    );
}

const settings = definePluginSettings({
    localBuildPath: {
        displayName: "Local Yomitan repository or build",
        description: "Path to the Yomitan repository, or directly to builds/yomitan-vencord-electron. Leave empty for ~/Desktop/yomitan.",
        type: OptionType.STRING,
        default: "",
        placeholder: "~/Desktop/yomitan"
    },
    nodePath: {
        displayName: "Node executable",
        description: "Node.js 22 or newer used for the isolated shared-store broker. Leave empty to discover it on PATH.",
        type: OptionType.STRING,
        default: "",
        placeholder: "/opt/homebrew/bin/node"
    },
    openSettings: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button onClick={() => void runNativeAction(
                Native.openSettings,
                "Failed to open Yomitan settings",
                "Opened the shared Yomitan settings"
            )}>
                Open Yomitan Settings
            </Button>
        )
    },
    reloadLocalBuild: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button onClick={() => void runNativeAction(
                Native.reloadLocalBuild,
                "Failed to reload local Yomitan",
                "Reloaded the local Yomitan build"
            )}>
                Reload Local Yomitan Build
            </Button>
        )
    }
});

export default definePlugin({
    name: "Yomitan",
    description: "Run the local Yomitan DOM scanner in Discord using the shared Firefox and macOS dictionary store",
    authors: [Devs.philosolog],
    tags: ["Chat", "Utility"],
    settings,
    restartNeeded: true,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.YomitanLanguageButton(),"
            }
        }
    ],

    YomitanLanguageButton: ErrorBoundary.wrap(YomitanLanguageButton, { noop: true })
});
