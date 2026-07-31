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

const settings = definePluginSettings({
    openSettings: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button
                onClick={async () => {
                    const error = await Native.openSettings();
                    if (error) showToast(`Failed to open Yomitan settings: ${error}`, Toasts.Type.FAILURE);
                }}
            >
                Open Yomitan Settings
            </Button>
        )
    }
});

export default definePlugin({
    name: "Yomitan",
    description: "Use the Yomitan popup dictionary on selectable text in Discord",
    authors: [Devs.philosolog],
    tags: ["Chat", "Utility"],
    settings,
    restartNeeded: true
});
