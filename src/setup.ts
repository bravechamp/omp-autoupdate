/**
 * Host-side wiring for omp-autoupdate: the KEY=value config file shared with
 * bin/omp-autoupdate, and the per-platform scheduler / wake-hook install.
 *
 * macOS: launchd agent (timer fallback) + sleepwatcher wake hook (~/.wakeup).
 * Linux: systemd --user timer with Persistent=true (missed ticks fire after resume).
 * Other: nothing to install; the extension's restart-on-update still works.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export type Presence = "lid" | "clamshell" | "user" | "none";
export const PRESENCE_VALUES: readonly Presence[] = ["lid", "clamshell", "user", "none"];

export interface Config {
	/** omp executable the updater runs; empty = `omp` on PATH. */
	ompBin: string;
	presence: Presence;
	/** Seconds between successful update runs. */
	minGap: number;
	/** Seconds to wait after wake before checking (Wi-Fi settle). */
	wakeSettle: number;
	/** Scheduler period in seconds (launchd StartInterval / systemd OnUnitActiveSec). */
	interval: number;
	/** Quiet seconds before a session restarts into a newer binary. */
	idleSeconds: number;
	tokenFile: string;
}

export const DEFAULT_CONFIG: Config = {
	ompBin: "",
	presence: "lid",
	minGap: 3600,
	wakeSettle: 20,
	interval: 4 * 3600,
	idleSeconds: 180,
	tokenFile: path.join(homedir(), ".secrets", "github_token"),
};

export const AGENT_DIR = getAgentDir();
export const CONFIG_FILE = path.join(AGENT_DIR, "autoupdate.conf");
export const HANDOFF_FILE = path.join(AGENT_DIR, "autoupdate-handoff.json");
export const SCRIPT_SOURCE = path.resolve(import.meta.dir, "..", "bin", "omp-autoupdate");
export const SCRIPT_LINK = path.join(homedir(), ".local", "bin", "omp-autoupdate");
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "omp-autoupdate");
export const LOG_FILE =
	process.platform === "darwin"
		? path.join(homedir(), "Library", "Logs", "omp-autoupdate.log")
		: path.join(STATE_DIR, "autoupdate.log");

const LAUNCHD_LABEL = "sh.omp.autoupdate";
const LAUNCHD_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const WAKEUP_HOOK = path.join(homedir(), ".wakeup");
const WAKEUP_MARKER = "# omp-autoupdate";
const SYSTEMD_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "systemd", "user");
const SYSTEMD_UNIT = "omp-autoupdate";

/** KEY=value config file: the shell script sources it, the extension parses it. */
export function loadConfig(): Config {
	const cfg: Config = { ...DEFAULT_CONFIG };
	if (!existsSync(CONFIG_FILE)) return cfg;
	for (const raw of readFileSync(CONFIG_FILE, "utf8").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = unquote(line.slice(eq + 1).trim());
		switch (key) {
			case "OMP_BIN":
				cfg.ompBin = value;
				break;
			case "PRESENCE":
				if (isPresence(value)) cfg.presence = value;
				break;
			case "MIN_GAP":
				cfg.minGap = positiveInt(value) ?? cfg.minGap;
				break;
			case "WAKE_SETTLE":
				cfg.wakeSettle = nonNegativeInt(value) ?? cfg.wakeSettle;
				break;
			case "INTERVAL":
				cfg.interval = positiveInt(value) ?? cfg.interval;
				break;
			case "IDLE_SECONDS":
				cfg.idleSeconds = positiveInt(value) ?? cfg.idleSeconds;
				break;
			case "TOKEN_FILE":
				cfg.tokenFile = value;
				break;
		}
	}
	return cfg;
}

export function saveConfig(cfg: Config): void {
	mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	const body = [
		"# omp-autoupdate configuration. Edit with `/autoupdate config <key> <value>` inside omp.",
		"# Sourced by bin/omp-autoupdate (sh) and parsed by the extension; keep KEY=value lines.",
		`OMP_BIN=${quote(cfg.ompBin)}`,
		`PRESENCE=${cfg.presence}`,
		`MIN_GAP=${cfg.minGap}`,
		`WAKE_SETTLE=${cfg.wakeSettle}`,
		`INTERVAL=${cfg.interval}`,
		`IDLE_SECONDS=${cfg.idleSeconds}`,
		`TOKEN_FILE=${quote(cfg.tokenFile)}`,
		"",
	].join("\n");
	writeFileSync(CONFIG_FILE, body);
}

export function isPresence(value: string): value is Presence {
	return (PRESENCE_VALUES as readonly string[]).includes(value);
}

function positiveInt(value: string): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(value: string): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/'\\''/g, "'");
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
	return value;
}

/** `4h`, `30m`, `90s`, `120` → seconds. */
export function parseDuration(value: string): number | undefined {
	const m = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
	return n * mult;
}

export function formatDuration(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function run(cmd: string[], options?: { timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult> {
	try {
		const proc = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: options?.timeoutMs ?? 60_000,
			env: options?.env ? { ...process.env, ...options.env } : process.env,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

export type Platform = "darwin" | "linux" | "unsupported";

export function platform(): Platform {
	if (process.platform === "darwin") return "darwin";
	if (process.platform === "linux") return "linux";
	return "unsupported";
}

function uid(): number {
	return process.getuid?.() ?? 501;
}

function linkScript(report: string[]): void {
	mkdirSync(path.dirname(SCRIPT_LINK), { recursive: true });
	let current: string | undefined;
	try {
		current = lstatSync(SCRIPT_LINK).isSymbolicLink() ? readlinkSync(SCRIPT_LINK) : undefined;
	} catch {
		current = undefined;
	}
	if (current === SCRIPT_SOURCE) {
		report.push(`✓ ${SCRIPT_LINK} → ${SCRIPT_SOURCE}`);
		return;
	}
	if (existsSync(SCRIPT_LINK) || current !== undefined) rmSync(SCRIPT_LINK, { force: true });
	symlinkSync(SCRIPT_SOURCE, SCRIPT_LINK);
	report.push(`+ ${SCRIPT_LINK} → ${SCRIPT_SOURCE}`);
}

function launchdPlist(cfg: Config): string {
	const pathEnv = [path.dirname(SCRIPT_LINK), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${SCRIPT_LINK}</string>
		<string>timer</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${pathEnv}</string>
		<key>HOME</key>
		<string>${homedir()}</string>
		<key>OMP_AGENT_DIR</key>
		<string>${AGENT_DIR}</string>
	</dict>
	<key>StartInterval</key>
	<integer>${cfg.interval}</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${LOG_FILE}.launchd</string>
	<key>StandardErrorPath</key>
	<string>${LOG_FILE}.launchd</string>
</dict>
</plist>
`;
}

async function installLaunchd(cfg: Config, report: string[]): Promise<void> {
	mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
	const next = launchdPlist(cfg);
	const unchanged = existsSync(LAUNCHD_PLIST) && readFileSync(LAUNCHD_PLIST, "utf8") === next;
	if (!unchanged) writeFileSync(LAUNCHD_PLIST, next);
	const domain = `gui/${uid()}`;
	await run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]);
	const boot = await run(["launchctl", "bootstrap", domain, LAUNCHD_PLIST]);
	if (boot.code !== 0) {
		report.push(`✗ launchctl bootstrap failed: ${boot.stderr.trim() || boot.code}`);
		return;
	}
	report.push(`${unchanged ? "✓" : "+"} launchd ${LAUNCHD_LABEL} every ${formatDuration(cfg.interval)} (timer fallback)`);
}

async function installWakeHook(report: string[]): Promise<void> {
	const brew = Bun.which("brew");
	if (!brew) {
		report.push("! Homebrew not found: wake trigger skipped (brew install sleepwatcher, then re-run install)");
		return;
	}
	const listed = await run([brew, "list", "--versions", "sleepwatcher"]);
	if (listed.code !== 0) {
		report.push("… installing sleepwatcher via Homebrew");
		const inst = await run([brew, "install", "sleepwatcher"], { timeoutMs: 10 * 60_000 });
		if (inst.code !== 0) {
			report.push(`✗ brew install sleepwatcher failed: ${lastLine(inst.stderr) || inst.code}`);
			return;
		}
		report.push("+ sleepwatcher installed");
	}
	const hookLine = `OMP_AGENT_DIR=${quote(AGENT_DIR)} "${SCRIPT_LINK}" wake >/dev/null 2>&1 &  ${WAKEUP_MARKER}`;
	if (existsSync(WAKEUP_HOOK)) {
		const body = readFileSync(WAKEUP_HOOK, "utf8");
		if (body.includes(WAKEUP_MARKER)) {
			report.push(`✓ ${WAKEUP_HOOK} already calls omp-autoupdate`);
		} else {
			const head = body.startsWith("#!") ? "" : "#!/bin/sh\n";
			writeFileSync(WAKEUP_HOOK, `${head}${body.endsWith("\n") || body === "" ? body : `${body}\n`}${hookLine}\n`, {
				mode: 0o755,
			});
			report.push(`+ appended omp-autoupdate to existing ${WAKEUP_HOOK}`);
		}
	} else {
		writeFileSync(WAKEUP_HOOK, `#!/bin/sh\n# sleepwatcher wake hook\n${hookLine}\n`, { mode: 0o755 });
		report.push(`+ ${WAKEUP_HOOK}`);
	}
	const running = await run(["pgrep", "-x", "sleepwatcher"]);
	if (running.code === 0) {
		report.push("✓ sleepwatcher running");
		return;
	}
	const start = await run([brew, "services", "start", "sleepwatcher"], { timeoutMs: 120_000 });
	report.push(
		start.code === 0
			? "+ sleepwatcher service started (brew services)"
			: `✗ brew services start sleepwatcher failed: ${lastLine(start.stderr) || start.code}`,
	);
}

function systemdUnits(cfg: Config): { service: string; timer: string } {
	const service = `[Unit]
Description=omp self-update (presence gated)

[Service]
Type=oneshot
ExecStart=${SCRIPT_LINK} timer
Environment=PATH=${path.dirname(SCRIPT_LINK)}:/usr/local/bin:/usr/bin:/bin
Environment=OMP_AGENT_DIR=${AGENT_DIR}
`;
	const timer = `[Unit]
Description=omp self-update timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=${cfg.interval}s
Persistent=true

[Install]
WantedBy=timers.target
`;
	return { service, timer };
}

async function installSystemd(cfg: Config, report: string[]): Promise<void> {
	if (!Bun.which("systemctl")) {
		report.push("! systemctl not found: no scheduler installed (run omp-autoupdate from cron instead)");
		return;
	}
	mkdirSync(SYSTEMD_DIR, { recursive: true });
	const units = systemdUnits(cfg);
	writeFileSync(path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.service`), units.service);
	writeFileSync(path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`), units.timer);
	const reload = await run(["systemctl", "--user", "daemon-reload"]);
	if (reload.code !== 0) {
		report.push(`✗ systemctl --user daemon-reload failed: ${reload.stderr.trim() || reload.code}`);
		return;
	}
	const enable = await run(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`]);
	report.push(
		enable.code === 0
			? `+ systemd user timer ${SYSTEMD_UNIT}.timer every ${formatDuration(cfg.interval)} (Persistent=true fires missed ticks after resume)`
			: `✗ systemctl --user enable --now failed: ${enable.stderr.trim() || enable.code}`,
	);
}

/** Wire the host. Idempotent; re-run after `config interval` changes. */
export async function install(cfg: Config): Promise<string[]> {
	const report: string[] = [];
	switch (platform()) {
		case "darwin":
			linkScript(report);
			await installLaunchd(cfg, report);
			await installWakeHook(report);
			break;
		case "linux":
			linkScript(report);
			await installSystemd(cfg, report);
			break;
		default:
			report.push(`! ${process.platform}: no scheduler support; schedule \`omp update\` yourself — session restart still works`);
	}
	return report;
}

export async function uninstall(): Promise<string[]> {
	const report: string[] = [];
	switch (platform()) {
		case "darwin": {
			await run(["launchctl", "bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
			if (existsSync(LAUNCHD_PLIST)) {
				rmSync(LAUNCHD_PLIST);
				report.push(`- ${LAUNCHD_PLIST}`);
			}
			if (existsSync(WAKEUP_HOOK)) {
				const kept = readFileSync(WAKEUP_HOOK, "utf8")
					.split("\n")
					.filter(line => !line.includes(WAKEUP_MARKER));
				const rest = kept.filter(line => line.trim() !== "" && !line.startsWith("#"));
				if (rest.length === 0) {
					rmSync(WAKEUP_HOOK);
					report.push(`- ${WAKEUP_HOOK} (sleepwatcher itself left installed)`);
				} else {
					writeFileSync(WAKEUP_HOOK, `${kept.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o755 });
					report.push(`- omp-autoupdate line removed from ${WAKEUP_HOOK}`);
				}
			}
			break;
		}
		case "linux": {
			if (Bun.which("systemctl")) await run(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
			for (const unit of [`${SYSTEMD_UNIT}.timer`, `${SYSTEMD_UNIT}.service`]) {
				const file = path.join(SYSTEMD_DIR, unit);
				if (existsSync(file)) {
					rmSync(file);
					report.push(`- ${file}`);
				}
			}
			if (Bun.which("systemctl")) await run(["systemctl", "--user", "daemon-reload"]);
			break;
		}
		default:
			break;
	}
	try {
		if (lstatSync(SCRIPT_LINK).isSymbolicLink()) {
			rmSync(SCRIPT_LINK);
			report.push(`- ${SCRIPT_LINK}`);
		}
	} catch {
		// not linked
	}
	report.push(`· kept ${CONFIG_FILE}`);
	return report;
}

export interface SchedulerStatus {
	kind: "launchd" | "systemd" | "none";
	installed: boolean;
	detail: string;
}

export interface WakeHookStatus {
	installed: boolean;
	detail: string;
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
	switch (platform()) {
		case "darwin": {
			if (!existsSync(LAUNCHD_PLIST)) return { kind: "launchd", installed: false, detail: "not installed" };
			const print = await run(["launchctl", "print", `gui/${uid()}/${LAUNCHD_LABEL}`]);
			if (print.code !== 0) return { kind: "launchd", installed: true, detail: "plist present but not loaded" };
			const interval = /run interval = (\d+) seconds/.exec(print.stdout)?.[1];
			const exit = /last exit code = (\S+)/.exec(print.stdout)?.[1];
			const parts = [`${LAUNCHD_LABEL} loaded`];
			if (interval) parts.push(`every ${formatDuration(Number(interval))}`);
			if (exit) parts.push(`last exit ${exit}`);
			return { kind: "launchd", installed: true, detail: parts.join(", ") };
		}
		case "linux": {
			if (!existsSync(path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`)))
				return { kind: "systemd", installed: false, detail: "not installed" };
			const active = await run(["systemctl", "--user", "is-active", `${SYSTEMD_UNIT}.timer`]);
			return { kind: "systemd", installed: true, detail: `${SYSTEMD_UNIT}.timer ${active.stdout.trim() || "unknown"}` };
		}
		default:
			return { kind: "none", installed: false, detail: `${process.platform}: unsupported` };
	}
}

export async function wakeHookStatus(): Promise<WakeHookStatus> {
	if (platform() !== "darwin") return { installed: false, detail: "macOS only" };
	const hooked = existsSync(WAKEUP_HOOK) && readFileSync(WAKEUP_HOOK, "utf8").includes(WAKEUP_MARKER);
	const running = (await run(["pgrep", "-x", "sleepwatcher"])).code === 0;
	if (!hooked) return { installed: false, detail: running ? "sleepwatcher running, ~/.wakeup not wired" : "not installed" };
	return { installed: running, detail: running ? "sleepwatcher running, ~/.wakeup wired" : "~/.wakeup wired, sleepwatcher NOT running" };
}

export function logTail(lines: number): string[] {
	if (!existsSync(LOG_FILE)) return [];
	const all = readFileSync(LOG_FILE, "utf8").split("\n").filter(line => line !== "");
	return all.slice(-lines);
}

export function lastSuccess(): Date | undefined {
	const stamp = path.join(STATE_DIR, "last-success");
	try {
		return lstatSync(stamp).mtime;
	} catch {
		return undefined;
	}
}

function lastLine(text: string): string {
	const lines = text.trim().split("\n");
	return lines[lines.length - 1] ?? "";
}
