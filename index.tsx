/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 philosolog
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/index";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Yomitan as PluginNative<typeof import("./native")>;

async function runNativeAction(action: () => Promise<string | null>, failurePrefix: string, success: string) {
    const error = await action();
    showToast(error ? `${failurePrefix}: ${error}` : success, error ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
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
        description: "Node.js 22 or newer used for the isolated shared-store broker. Leave empty to discover Homebrew or /usr/local Node.",
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
    restartNeeded: true
});
