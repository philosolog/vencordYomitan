/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 philosolog
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { RendererSettings } from "@main/settings";
import { DATA_DIR } from "@main/utils/constants";
import { app, BrowserWindow, Extension, IpcMainInvokeEvent, session, webContents } from "electron";

const EXTENSION_NAME = "Yomitan (Vencord Shared Store)";
const DEFAULT_BUILD_DIRECTORY = "yomitan-vencord-electron";
const STAGED_EXTENSION_DIRECTORY = join(DATA_DIR, "YomitanExtension", "current");
const STATUS_PATH = join(DATA_DIR, "YomitanExtension", "status.json");
const settingsWindows = new Set<BrowserWindow>();

export interface YomitanStatus {
    state: "idle" | "starting" | "ready" | "error";
    artifactPath: string | null;
    extensionId: string | null;
    extensionVersion: string | null;
    brokerPort: number | null;
    sharedStoreRoot: string;
    contentScripts: Array<{ url: string; state: string; }>;
    error: string | null;
}

let status: YomitanStatus = {
    state: "idle",
    artifactPath: null,
    extensionId: null,
    extensionVersion: null,
    brokerPort: null,
    sharedStoreRoot: join(homedir(), "Library", "Application Support", "Yomitan"),
    contentScripts: [],
    error: null
};
let broker: ChildProcess | null = null;
let loadedExtension: Extension | null = null;
let loadingPromise: Promise<Extension> | null = null;
let contentScriptMonitor: NodeJS.Timeout | null = null;

function isDiscordUrl(url: string) {
    return /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\//.test(url);
}

async function refreshContentScriptStatus() {
    const views = webContents.getAllWebContents().filter(view => isDiscordUrl(view.getURL()) && !view.isDestroyed());
    const contentScripts = await Promise.all(views.map(async view => {
        try {
            const state = await view.executeJavaScript(
                "document.documentElement?.getAttribute('data-yomitan-content-script') ?? 'missing'",
                true
            );
            return { url: view.getURL(), state: String(state) };
        } catch (error) {
            return { url: view.getURL(), state: `probe-error: ${errorMessage(error)}` };
        }
    }));
    if (JSON.stringify(contentScripts) !== JSON.stringify(status.contentScripts)) {
        status = { ...status, contentScripts };
        persistStatus();
    }
}

function startContentScriptMonitor() {
    if (contentScriptMonitor !== null) clearInterval(contentScriptMonitor);
    void refreshContentScriptStatus();
    contentScriptMonitor = setInterval(() => void refreshContentScriptStatus(), 2_000);
    contentScriptMonitor.unref();
}

function reloadExistingDiscordDocuments() {
    for (const view of webContents.getAllWebContents()) {
        if (isDiscordUrl(view.getURL()) && !view.isDestroyed()) view.reload();
    }
}

function pluginSettings(): { enabled?: boolean; localBuildPath?: string; nodePath?: string; } {
    return RendererSettings.store.plugins?.Yomitan ?? {};
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function persistStatus() {
    void mkdir(dirname(STATUS_PATH), { recursive: true })
        .then(() => writeFile(STATUS_PATH, JSON.stringify(status, null, 4)))
        .catch(error => console.error("[Yomitan] Failed to persist status", error));
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
    const url = event.senderFrame?.url ?? "";
    if (!/^(https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/|chrome-extension:\/\/)/.test(url)) {
        throw new Error("Untrusted Yomitan IPC sender");
    }
}

async function pathExists(path: string) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function resolveArtifact() {
    const configured = String(pluginSettings().localBuildPath ?? "").trim();
    const candidates = [
        configured,
        process.env.YOMITAN_VENCORD_BUILD ?? "",
        join(homedir(), "Desktop", "yomitan", "builds", DEFAULT_BUILD_DIRECTORY)
    ].filter(Boolean).map(path => resolve(path));

    for (const candidate of candidates) {
        const directory = basename(candidate) === DEFAULT_BUILD_DIRECTORY
            ? candidate
            : join(candidate, "builds", DEFAULT_BUILD_DIRECTORY);
        if (await pathExists(join(directory, "manifest.json"))) {
            const projectRoot = resolve(directory, "..", "..");
            if (!await pathExists(join(projectRoot, "native", "electron-shared-store-host.mjs"))) {
                throw new Error(`Yomitan broker was not found under ${projectRoot}`);
            }
            return { artifactPath: directory, projectRoot };
        }
    }

    throw new Error(
        "Local Yomitan build not found. Run `npm run build:vencord` in the Yomitan repository, " +
        "then set Local build path in the plugin settings if the repository is not at ~/Desktop/yomitan."
    );
}

async function stageArtifact(artifactPath: string) {
    const manifest = JSON.parse(await readFile(join(artifactPath, "manifest.json"), "utf8"));
    if (manifest.name !== EXTENSION_NAME || manifest.x_yomitan_shared_store?.transport !== "loopback") {
        throw new Error("The selected directory is not a Yomitan Vencord shared-store build");
    }

    const parent = dirname(STAGED_EXTENSION_DIRECTORY);
    const temporary = join(parent, `.staging-${process.pid}-${Date.now()}`);
    await mkdir(parent, { recursive: true });
    await cp(artifactPath, temporary, { recursive: true });
    await rm(STAGED_EXTENSION_DIRECTORY, { recursive: true, force: true });
    await rename(temporary, STAGED_EXTENSION_DIRECTORY);
}

async function resolveNodeExecutable() {
    const configured = String(pluginSettings().nodePath ?? "").trim();
    const candidates = [configured, process.env.YOMITAN_NODE ?? "", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        .filter(Boolean)
        .map(path => resolve(path));
    for (const candidate of candidates) {
        if (await pathExists(candidate)) return candidate;
    }
    throw new Error("Node.js 22 or newer was not found; set Node executable in the Yomitan plugin settings");
}

async function startBroker(projectRoot: string, token: string) {
    const nodeExecutable = await resolveNodeExecutable();
    return await new Promise<{ process: ChildProcess; port: number; }>((resolveReady, rejectReady) => {
        const child = spawn(nodeExecutable, [join(projectRoot, "native", "electron-shared-store-host.mjs")], {
            cwd: projectRoot,
            env: {
                ...process.env,
                YOMITAN_BROKER_TOKEN: token,
                YOMITAN_ROOT: projectRoot,
                YOMITAN_SHARED_STORE: status.sharedStoreRoot
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let startupSettled = false;
        const rejectStartup = (error: unknown) => {
            if (startupSettled) return;
            startupSettled = true;
            clearTimeout(timeout);
            rejectReady(error);
        };
        const timeout = setTimeout(() => {
            child.kill();
            rejectStartup(new Error(`Yomitan broker startup timed out${stderr ? `: ${stderr.trim()}` : ""}`));
        }, 60_000);

        child.stderr?.on("data", data => {
            stderr += data.toString();
            console.error("[Yomitan broker]", data.toString().trim());
        });
        child.stdout?.on("data", data => {
            stdout += data.toString();
            const newline = stdout.indexOf("\n");
            if (newline < 0) return;
            try {
                const handshake = JSON.parse(stdout.slice(0, newline));
                if (handshake.ready !== true || handshake.protocolVersion !== 1 || !Number.isInteger(handshake.port)) {
                    throw new Error("Invalid broker handshake");
                }
                startupSettled = true;
                clearTimeout(timeout);
                resolveReady({ process: child, port: handshake.port });
            } catch (error) {
                child.kill();
                rejectStartup(error);
            }
        });
        child.once("exit", code => {
            rejectStartup(new Error(`Yomitan broker exited during startup with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
            if (broker === child) {
                broker = null;
                status = { ...status, state: "error", brokerPort: null, error: `Yomitan broker exited with code ${code}` };
                persistStatus();
            }
        });
        child.once("error", error => {
            rejectStartup(new Error(`Yomitan broker failed to start: ${errorMessage(error)}`));
        });
    });
}

async function stopRuntime() {
    if (contentScriptMonitor !== null) {
        clearInterval(contentScriptMonitor);
        contentScriptMonitor = null;
    }
    for (const win of settingsWindows) win.close();
    settingsWindows.clear();
    if (loadedExtension) {
        session.defaultSession.extensions.removeExtension(loadedExtension.id);
        loadedExtension = null;
    }
    broker?.kill();
    broker = null;
    rmSync(join(STAGED_EXTENSION_DIRECTORY, "bridge-config.json"), { force: true });
    status = { ...status, state: "idle", extensionId: null, extensionVersion: null, brokerPort: null, contentScripts: [] };
    persistStatus();
}

async function loadLocalBuild(): Promise<Extension> {
    status = { ...status, state: "starting", error: null };
    const { artifactPath, projectRoot } = await resolveArtifact();
    status = { ...status, artifactPath };
    await stageArtifact(artifactPath);

    const token = randomBytes(32).toString("base64url");
    const brokerResult = await startBroker(projectRoot, token);
    broker = brokerResult.process;
    status = { ...status, brokerPort: brokerResult.port };
    await writeFile(join(STAGED_EXTENSION_DIRECTORY, "bridge-config.json"), JSON.stringify({
        protocolVersion: 1,
        endpoint: `http://127.0.0.1:${brokerResult.port}/rpc`,
        token,
        renderer: {
            owner: "vencord-yomitan",
            priority: 200,
            ttlMs: 2500,
            scopes: ["com.hnc.Discord"]
        }
    }, null, 4));

    try {
        const extension = await session.defaultSession.extensions.loadExtension(STAGED_EXTENSION_DIRECTORY, {
            allowFileAccess: true
        });
        if (extension.name !== EXTENSION_NAME) throw new Error(`Unexpected extension loaded: ${extension.name}`);
        loadedExtension = extension;
        status = {
            ...status,
            state: "ready",
            extensionId: extension.id,
            extensionVersion: extension.version,
            error: null
        };
        persistStatus();
        startContentScriptMonitor();
        reloadExistingDiscordDocuments();
        return extension;
    } catch (error) {
        broker?.kill();
        broker = null;
        rmSync(join(STAGED_EXTENSION_DIRECTORY, "bridge-config.json"), { force: true });
        throw error;
    }
}

async function ensureLoaded() {
    if (loadedExtension) return loadedExtension;
    if (loadingPromise) return loadingPromise;
    loadingPromise = loadLocalBuild().catch(error => {
        status = { ...status, state: "error", error: errorMessage(error) };
        persistStatus();
        console.error("[Yomitan] Failed to load local extension", error);
        throw error;
    }).finally(() => loadingPromise = null);
    return loadingPromise;
}

app.whenReady().then(() => {
    if (pluginSettings().enabled) void ensureLoaded();
});
app.once("before-quit", () => void stopRuntime());

export async function getStatus(event: IpcMainInvokeEvent) {
    assertTrustedSender(event);
    return status;
}

export async function reloadLocalBuild(event: IpcMainInvokeEvent) {
    try {
        assertTrustedSender(event);
        await stopRuntime();
        await ensureLoaded();
        return null;
    } catch (error) {
        return errorMessage(error);
    }
}

export async function openSettings(event: IpcMainInvokeEvent) {
    try {
        assertTrustedSender(event);
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
                sandbox: true,
                session: session.defaultSession
            }
        });

        settingsWindows.add(win);
        win.once("closed", () => settingsWindows.delete(win));
        await win.loadURL(`chrome-extension://${extension.id}/${optionsPage}`);
        return null;
    } catch (error) {
        return errorMessage(error);
    }
}
