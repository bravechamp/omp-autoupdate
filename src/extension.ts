/**
 * omp-autoupdate extension
 *
 * 1. Restart-on-update (every platform): watches the running executable on disk;
 *    when a newer version lands (any updater: this package's scheduler, a cron job,
 *    a manual `omp update`) and the session has been quiet for `idle` seconds, drives
 *    the built-in `/restart`, which execs the new binary and resumes this session.
 *
 * 2. `/autoupdate` command: install/uninstall the host scheduler and wake hook
 *    (macOS launchd + sleepwatcher, Linux systemd --user), show status, edit config,
 *    trigger a check now, tail the log.
 */
import { statSync, unlinkSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text, VERSION } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@oh-my-pi/pi-tui";
import pkg from "../package.json" with { type: "json" };
import {
	AGENT_DIR,
	type Config,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	formatDuration,
	HANDOFF_FILE,
	install,
	isPresence,
	lastSuccess,
	loadConfig,
	LOG_FILE,
	logTail,
	parseDuration,
	platform,
	PRESENCE_VALUES,
	run,
	saveConfig,
	schedulerStatus,
	SCRIPT_LINK,
	SCRIPT_SOURCE,
	uninstall,
	wakeHookStatus,
} from "./setup";

const POLL_MS = 60_000;
const RESTART_TIMEOUT_MS = 15_000;
const HANDOFF_MAX_AGE_MS = 5 * 60_000;
const WIDGET_KEY = "omp-autoupdate";
const LOG_TAG = "omp-autoupdate";

interface BinaryStamp {
	ino: number;
	mtimeMs: number;
	size: number;
}

interface Handoff {
	from: string;
	to: string;
	sessionId: string | undefined;
	at: number;
}

const SUBCOMMANDS: readonly AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Versions, scheduler, wake hook, config, recent log" },
	{ value: "install", label: "install", description: "Wire the scheduler and wake hook on this host" },
	{ value: "uninstall", label: "uninstall", description: "Remove scheduler and wake hook (keeps config)" },
	{ value: "now", label: "now", description: "Run the updater immediately, bypassing gates" },
	{ value: "config", label: "config", description: "Show or set: presence, min-gap, wake-settle, interval, idle, token-file, omp-bin" },
	{ value: "log", label: "log", description: "Last 40 updater log lines" },
];

const CONFIG_KEYS = ["presence", "min-gap", "wake-settle", "interval", "idle", "token-file", "omp-bin"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(value: string): value is ConfigKey {
	return (CONFIG_KEYS as readonly string[]).includes(value);
}

function stampOf(file: string): BinaryStamp | undefined {
	try {
		const s = statSync(file);
		return { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return undefined;
	}
}

/** `omp --version` prints `omp/X.Y.Z`. */
async function binaryVersion(file: string): Promise<string | undefined> {
	const result = await run([file, "--version"], { timeoutMs: 15_000 });
	return /omp\/(\S+)/.exec(result.stdout)?.[1];
}

/** The composer is focused iff the focused component reads back the text we just set. */
function readsText(component: Component | null): component is Component & { getText(): string } {
	if (!component) return false;
	const candidate = component as Component & { getText?: unknown }; // structural probe on an opaque TUI node
	return typeof candidate.getText === "function";
}

function isHandoff(value: unknown): value is Handoff {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>; // each field checked below
	return (
		typeof v.from === "string" &&
		typeof v.to === "string" &&
		typeof v.at === "number" &&
		(v.sessionId === undefined || typeof v.sessionId === "string")
	);
}

async function readHandoff(): Promise<Handoff | undefined> {
	const file = Bun.file(HANDOFF_FILE);
	if (!(await file.exists())) return undefined;
	try {
		const parsed: unknown = await file.json();
		return isHandoff(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			unlinkSync(HANDOFF_FILE);
		} catch {
			// already gone
		}
	}
}

/** Read-only text panel; Esc / q / Enter closes. */
class Panel implements Component {
	focused = false;
	#width = -1;
	#rows: readonly string[] = [];
	constructor(
		private readonly lines: readonly string[],
		private readonly done: () => void,
	) {}
	render(width: number): readonly string[] {
		if (width !== this.#width) {
			this.#width = width;
			this.#rows = this.lines.map(line => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line));
		}
		return this.#rows;
	}
	handleInput(data: string): void {
		if (data === "\x1b" || data === "q" || data === "\r" || data === "\n") this.done();
	}
}

async function present(ctx: ExtensionContext, title: string, lines: readonly string[]): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify([title, ...lines].join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const body = [theme.fg("accent", title), ...lines, "", theme.fg("muted", "esc / q / enter to close")];
		return new Panel(body, () => done());
	});
}

function describeConfig(cfg: Config): string[] {
	return [
		`presence     ${cfg.presence}   (lid | clamshell | user | none)`,
		`min-gap      ${formatDuration(cfg.minGap)}   between successful runs`,
		`wake-settle  ${formatDuration(cfg.wakeSettle)}   after wake before checking`,
		`interval     ${formatDuration(cfg.interval)}   scheduler period (re-applied on install)`,
		`idle         ${formatDuration(cfg.idleSeconds)}   quiet time before a session restarts`,
		`token-file   ${cfg.tokenFile}`,
		`omp-bin      ${cfg.ompBin || "(omp on PATH)"}`,
	];
}

function applyConfig(cfg: Config, key: ConfigKey, raw: string): string | undefined {
	switch (key) {
		case "presence":
			if (!isPresence(raw)) return `presence must be one of ${PRESENCE_VALUES.join(", ")}`;
			cfg.presence = raw;
			return undefined;
		case "min-gap":
		case "wake-settle":
		case "interval":
		case "idle": {
			const seconds = parseDuration(raw);
			if (seconds === undefined) return `${key} needs a duration like 30m, 4h, or 120 (seconds)`;
			if (seconds === 0 && key !== "wake-settle") return `${key} must be > 0`;
			if (key === "min-gap") cfg.minGap = seconds;
			else if (key === "wake-settle") cfg.wakeSettle = seconds;
			else if (key === "interval") cfg.interval = seconds;
			else cfg.idleSeconds = seconds;
			return undefined;
		}
		case "token-file":
			cfg.tokenFile = raw;
			return undefined;
		case "omp-bin":
			cfg.ompBin = raw === "-" ? "" : raw;
			return undefined;
	}
}

export default function ompAutoupdate(pi: ExtensionAPI) {
	pi.setLabel("omp auto-update");

	const execPath = process.execPath;
	let cfg = loadConfig();
	let baseline = stampOf(execPath);
	let pendingVersion: string | undefined;
	let ticking = false;
	let restartArmed = false;
	let lastActivity = Date.now();
	let tui: TUI | undefined;
	let live: ExtensionContext | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;
	let polling = false;

	const touch = (): void => {
		if (!restartArmed) lastActivity = Date.now();
	};
	for (const event of ["input", "turn_start", "turn_end", "agent_start", "agent_end", "tool_execution_end"] as const) {
		pi.on(event, () => {
			touch();
		});
	}

	function attach(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		live = ctx;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput(() => {
			touch();
			return undefined;
		});
		if (!polling) {
			polling = true;
			ctx.setInterval(() => void tick(), POLL_MS);
		}
	}

	function quiet(ctx: ExtensionContext): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
		const jobs = ctx.getAsyncJobSnapshot();
		if (jobs && jobs.running.length > 0) return false;
		if (ctx.ui.getEditorText().trim() !== "") return false;
		return Date.now() - lastActivity >= cfg.idleSeconds * 1000;
	}

	function showPending(ctx: ExtensionContext, version: string): void {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(ui, theme) => {
				tui = ui;
				return new Text(
					theme.fg("muted", `⟳ omp ${version} installed · restarting when idle ${formatDuration(cfg.idleSeconds)}`),
					1,
					0,
				);
			},
			{ placement: "belowEditor" },
		);
	}

	async function detect(ctx: ExtensionContext): Promise<void> {
		const current = stampOf(execPath);
		if (!current) return;
		if (!baseline) {
			baseline = current;
			return;
		}
		if (current.ino === baseline.ino && current.mtimeMs === baseline.mtimeMs && current.size === baseline.size) return;
		const version = await binaryVersion(execPath);
		if (!version) return; // mid-replace or unreadable; look again next tick
		baseline = current;
		if (version === VERSION) return; // same version re-installed
		pendingVersion = version;
		pi.logger.info(`${LOG_TAG}: ${version} on disk, running ${VERSION}; restart when idle ${cfg.idleSeconds}s`);
		ctx.ui.notify(`omp ${version} installed (running ${VERSION}) — this session restarts when idle`, "info");
		showPending(ctx, version);
	}

	function requestRestart(ctx: ExtensionContext): void {
		if (restartArmed || !tui || !pendingVersion) return;
		ctx.ui.setEditorText("/restart");
		const focused = tui.getFocused();
		if (!readsText(focused) || focused.getText() !== "/restart") {
			ctx.ui.setEditorText("");
			pi.logger.warn(`${LOG_TAG}: composer not focused (overlay open?); deferring restart`);
			return;
		}
		restartArmed = true;
		const handoff: Handoff = {
			from: VERSION,
			to: pendingVersion,
			sessionId: ctx.sessionManager.getSessionId(),
			at: Date.now(),
		};
		void Bun.write(HANDOFF_FILE, JSON.stringify(handoff));
		pi.logger.info(`${LOG_TAG}: restarting into ${pendingVersion} (session ${handoff.sessionId ?? "unsaved"})`);
		ctx.ui.notify(`Restarting into omp ${pendingVersion}…`, "info");
		tui.injectDebugInput("\r");
		ctx.setTimeout(() => {
			restartArmed = false;
			if (ctx.ui.getEditorText() === "/restart") ctx.ui.setEditorText("");
			pi.logger.warn(`${LOG_TAG}: /restart did not take within ${RESTART_TIMEOUT_MS}ms; will retry`);
		}, RESTART_TIMEOUT_MS);
	}

	async function tick(): Promise<void> {
		const ctx = live;
		if (!ctx || ticking) return;
		ticking = true;
		try {
			if (pendingVersion === undefined) await detect(ctx);
			else if (quiet(ctx)) requestRestart(ctx);
		} finally {
			ticking = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		attach(ctx);
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!(await Bun.file(CONFIG_FILE).exists())) {
			cfg = { ...DEFAULT_CONFIG, ompBin: execPath };
			saveConfig(cfg);
			if (platform() !== "unsupported") {
				ctx.ui.notify("omp-autoupdate: run /autoupdate install to wire the update scheduler", "info");
			}
		}
		const handoff = await readHandoff();
		if (!handoff) return;
		const fresh = Date.now() - handoff.at < HANDOFF_MAX_AGE_MS;
		const sameSession = handoff.sessionId === undefined || handoff.sessionId === ctx.sessionManager.getSessionId();
		if (!fresh || !sameSession) return;
		pi.logger.info(`${LOG_TAG}: resumed on ${VERSION} (was ${handoff.from})`);
		ctx.ui.notify(`omp updated ${handoff.from} → ${VERSION}; session resumed`, "info");
	});
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_event, ctx) => {
			attach(ctx);
		});
	}
	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		polling = false;
		live = undefined;
	});

	async function status(ctx: ExtensionCommandContext): Promise<void> {
		const [onDisk, scheduler, wake] = await Promise.all([binaryVersion(execPath), schedulerStatus(), wakeHookStatus()]);
		const disk =
			onDisk === undefined
				? "unreadable"
				: onDisk === VERSION
					? `${onDisk} ✓`
					: `${onDisk} — restart when idle${pendingVersion ? "" : " (pending detection)"}`;
		const stamp = lastSuccess();
		const lines = [
			`running      ${VERSION}   ${execPath}`,
			`on disk      ${disk}`,
			`platform     ${process.platform}`,
			`scheduler    ${scheduler.detail}`,
			`wake hook    ${wake.detail}`,
			`last success ${stamp ? stamp.toLocaleString() : "never"}`,
			"",
			...describeConfig(cfg),
			"",
			`config       ${CONFIG_FILE}`,
			`log          ${LOG_FILE}`,
			...logTail(6).map(line => `  ${line}`),
		];
		await present(ctx, `omp-autoupdate ${pkg.version}`, lines);
	}

	async function configCommand(ctx: ExtensionCommandContext, key: string | undefined, value: string | undefined): Promise<void> {
		if (key === undefined) {
			await present(ctx, "omp-autoupdate config", [...describeConfig(cfg), "", `set: /autoupdate config <key> <value>`]);
			return;
		}
		if (!isConfigKey(key)) {
			ctx.ui.notify(`unknown key ${key}; keys: ${CONFIG_KEYS.join(", ")}`, "error");
			return;
		}
		if (value === undefined) {
			const line = describeConfig(cfg).find(entry => entry.startsWith(key));
			ctx.ui.notify(line ?? key, "info");
			return;
		}
		const next = { ...cfg };
		const error = applyConfig(next, key, value);
		if (error) {
			ctx.ui.notify(error, "error");
			return;
		}
		cfg = next;
		saveConfig(cfg);
		if (key === "interval" && (await schedulerStatus()).installed) {
			const report = await install(cfg);
			await present(ctx, `interval → ${formatDuration(cfg.interval)}; scheduler re-applied`, report);
			return;
		}
		if (key === "idle" && pendingVersion && live) showPending(live, pendingVersion);
		ctx.ui.notify(`${key} = ${value}`, "info");
	}

	async function now(ctx: ExtensionCommandContext): Promise<void> {
		const script = (await Bun.file(SCRIPT_LINK).exists()) ? SCRIPT_LINK : SCRIPT_SOURCE;
		ctx.ui.notify("omp-autoupdate: checking for updates…", "info");
		const result = await run([script, "manual", "--force"], {
			timeoutMs: 10 * 60_000,
			env: { OMP_AGENT_DIR: AGENT_DIR },
		});
		const lines = logTail(8).map(line => `  ${line}`);
		if (result.code !== 0) lines.push("", `exit ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
		await present(ctx, result.code === 0 ? "omp-autoupdate: check finished" : "omp-autoupdate: check failed", lines);
		void tick();
	}

	pi.registerCommand("autoupdate", {
		description: "Manage omp self-update: status | install | uninstall | now | config | log",
		getArgumentCompletions: prefix => {
			const [head, ...rest] = prefix.trimStart().split(/\s+/);
			if (rest.length === 0) return SUBCOMMANDS.filter(item => item.value.startsWith(head ?? ""));
			if (head === "config" && rest.length === 1) {
				return CONFIG_KEYS.filter(key => key.startsWith(rest[0] ?? "")).map(key => ({
					value: `config ${key}`,
					label: key,
				}));
			}
			if (head === "config" && rest[0] === "presence") {
				return PRESENCE_VALUES.filter(value => value.startsWith(rest[1] ?? "")).map(value => ({
					value: `config presence ${value}`,
					label: value,
				}));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(part => part !== "");
			switch (sub) {
				case "status":
					await status(ctx);
					return;
				case "install": {
					cfg = { ...cfg, ompBin: cfg.ompBin || execPath };
					saveConfig(cfg);
					const report = await install(cfg);
					await present(ctx, "omp-autoupdate install", report);
					return;
				}
				case "uninstall": {
					const report = await uninstall();
					await present(ctx, "omp-autoupdate uninstall", report);
					return;
				}
				case "now":
					await now(ctx);
					return;
				case "config":
					await configCommand(ctx, rest[0], rest.slice(1).join(" ") || undefined);
					return;
				case "log":
					await present(ctx, LOG_FILE, logTail(40));
					return;
				default:
					ctx.ui.notify(`/autoupdate: unknown subcommand ${sub}; use ${SUBCOMMANDS.map(item => item.value).join(" | ")}`, "error");
			}
		},
	});
}
