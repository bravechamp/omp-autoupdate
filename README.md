# omp-autoupdate

Keep [omp](https://omp.sh) current without thinking about it.

- **Restart on update** — every platform. A running session notices when a newer `omp`
  binary lands on disk (from this package's scheduler, a cron job, or a manual
  `omp update`), shows `⟳ omp X installed · restarting when idle`, and once the session
  has been quiet for a while it runs the built-in `/restart`: the new binary is exec'd in
  place and the session resumes with its transcript intact.
- **Presence-gated updater** — macOS (launchd + [sleepwatcher](https://github.com/bernhard-baehr/sleepwatcher)
  wake hook) and Linux (`systemd --user` timer). `omp update` runs when you open the lid
  or wake the machine, never on a dark wake, and at most once per `min-gap`. A periodic
  timer covers days the lid never closes.

Upstream has no auto-update yet (see can1357/oh-my-pi #9035, #2712, PR #7748); this
package composes what already exists — `omp update` (verified download, atomic replace,
rollback) and `/restart` — with a presence gate.

## Install

```sh
omp plugin install github:bravechamp/omp-autoupdate     # or: omp plugin link /path/to/omp-autoupdate
```

Start a session, then:

```
/autoupdate install
```

On macOS this links `~/.local/bin/omp-autoupdate`, loads the launchd agent
`sh.omp.autoupdate`, installs `sleepwatcher` via Homebrew if missing, starts it with
`brew services`, and adds one line to `~/.wakeup`. On Linux it writes and enables
`~/.config/systemd/user/omp-autoupdate.{service,timer}` (`Persistent=true`, so a missed
tick fires after resume). Re-run `install` any time; it is idempotent.

## Commands

| Command | Effect |
| --- | --- |
| `/autoupdate` / `/autoupdate status` | Running vs on-disk version, scheduler and wake-hook state, config, last log lines |
| `/autoupdate install` | Wire the host (see above) |
| `/autoupdate uninstall` | Unload the scheduler, unwire `~/.wakeup`, remove the symlink; keeps config and sleepwatcher |
| `/autoupdate now` | Run the updater immediately, bypassing every gate |
| `/autoupdate config [key [value]]` | Show or set a setting |
| `/autoupdate log` | Last 40 updater log lines |

## Config

Stored in `~/.omp/agent/autoupdate.conf` (`KEY=value`; sourced by the shell updater,
parsed by the extension). Durations accept `90`, `90s`, `30m`, `4h`, `1d`.

| Key | Default | Meaning |
| --- | --- | --- |
| `presence` | `lid` | `lid` — lid must be open. `clamshell` — lid open, **or** lid closed with recent keyboard/mouse input (external display). `user` — recent input, lid ignored. `none` — no presence gate. |
| `min-gap` | `1h` | Minimum time between successful update runs |
| `wake-settle` | `20s` | Wait after wake before checking (Wi-Fi reconnect) |
| `interval` | `4h` | Timer period; re-applies the scheduler when changed |
| `idle` | `3m` | Quiet time (no keystrokes, turns, tool runs, queued messages, async jobs, or composer text) before a session restarts into a newer binary |
| `token-file` | `~/.secrets/github_token` | GitHub token for release metadata; unauthenticated requests are limited to 60/h per IP |
| `omp-bin` | running executable | Which `omp` the updater runs (`-` to use `omp` on PATH) |

Presence signals: macOS lid = `ioreg AppleClamshellState`, user = WindowServer's
`UserIsActive` power assertion (`pmset -g assertions`, roughly a 10-minute window,
never set by Power Nap / dark wakes). Linux lid = `/proc/acpi/button/lid/*/state`,
user = `loginctl … IdleHint`.

## How the pieces fit

```
lid open / wake ──▶ sleepwatcher ──▶ ~/.wakeup ──▶ omp-autoupdate wake ─┐
launchd / systemd timer ───────────▶ omp-autoupdate timer ──────────────┤
/autoupdate now ───────────────────▶ omp-autoupdate manual --force ─────┤
                                                                         ▼
                                    gates: presence · min-gap · lock ──▶ omp update
                                                                         │
                     running sessions (extension, 60 s poll) ◀───────────┘
                     newer binary on disk ──▶ quiet for `idle` ──▶ /restart --resume
```

The updater only stamps `last-success` on exit 0, so a wake without network is retried
by the next wake or timer tick. Log: `~/Library/Logs/omp-autoupdate.log` (macOS) or
`~/.local/state/omp-autoupdate/autoupdate.log`.

## Notes and limits

- Windows: the extension's restart works through omp's spawn fallback; there is no
  scheduler support — schedule `omp update` with Task Scheduler.
- The restart is deferred while an ask dialog or overlay owns the composer, and while
  the composer holds an unsent draft.
- Mode state that `/restart` itself does not persist (plan/vibe) is not carried over.
- Package-manager installs (brew, mise, bun, npm) are updated through that manager by
  `omp update`; the gate logic is the same.
