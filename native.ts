/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { installExt } from "@main/utils/extensions";
import { app, BrowserWindow, Extension, IpcMainInvokeEvent, session } from "electron";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const EXTENSION_ID = "likgccmbimhjbgkjambclfkhldnlhbnn";
const EXTENSION_NAME = "Yomitan Popup Dictionary";
const settingsWindows = new Set<BrowserWindow>();
let loadingPromise: Promise<Extension> | undefined;

async function applyElectronCompatibility(extension: Extension) {
    const permissionsUtilPath = join(extension.path, "js/data/permissions-util.js");
    const source = await readFile(permissionsUtilPath, "utf8");
    const marker = "/* Vencord Electron compatibility */";
    if (source.includes(marker)) return extension;

    const patchedSource = source
        .replace(
            "export function hasPermissions(permissions) {\n",
            `export function hasPermissions(permissions) {
    ${marker}
    if (typeof chrome.permissions !== 'object') {
        const manifest = chrome.runtime.getManifest();
        const available = new Set([...(manifest.permissions || []), ...(manifest.host_permissions || [])]);
        return Promise.resolve([
            ...(permissions.permissions || []),
            ...(permissions.origins || []),
        ].every((permission) => available.has(permission)));
    }
`
        )
        .replace(
            "export function setPermissionsGranted(permissions, shouldHave) {\n",
            `export function setPermissionsGranted(permissions, shouldHave) {
    ${marker}
    if (typeof chrome.permissions !== 'object') {
        return Promise.resolve(false);
    }
`
        )
        .replace(
            "export function getAllPermissions() {\n",
            `export function getAllPermissions() {
    ${marker}
    if (typeof chrome.permissions !== 'object') {
        const manifest = chrome.runtime.getManifest();
        return Promise.resolve({
            permissions: manifest.permissions || [],
            origins: manifest.host_permissions || [],
        });
    }
`
        );

    if (patchedSource === source) {
        throw new Error("Yomitan permissions compatibility patch did not apply");
    }

    await writeFile(permissionsUtilPath, patchedSource);
    session.defaultSession.extensions.removeExtension(extension.id);
    return session.defaultSession.extensions.loadExtension(extension.path);
}

function getLoadedExtension() {
    return session.defaultSession.extensions.getAllExtensions().find(extension => extension.name === EXTENSION_NAME);
}

async function ensureLoaded(): Promise<Extension> {
    const loadedExtension = getLoadedExtension();
    if (loadedExtension) return loadedExtension;

    return loadingPromise ??= installExt(EXTENSION_ID)
        .then(applyElectronCompatibility)
        .finally(() => loadingPromise = undefined);
}

app.whenReady().then(() => {
    if (RendererSettings.store.plugins?.Yomitan?.enabled) {
        ensureLoaded().catch(error => console.error("[Yomitan] Failed to load extension", error));
    }
});

export async function openSettings(_: IpcMainInvokeEvent) {
    try {
        const extension = await ensureLoaded();
        const optionsPage = extension.manifest.options_ui?.page ?? "settings.html";
        const win = new BrowserWindow({
            title: "Yomitan Settings",
            width: 1100,
            height: 800,
            autoHideMenuBar: true,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                session: session.defaultSession
            }
        });

        settingsWindows.add(win);
        win.once("closed", () => settingsWindows.delete(win));
        await win.loadURL(`chrome-extension://${extension.id}/${optionsPage}`);
        return null;
    } catch (error) {
        return String(error);
    }
}
