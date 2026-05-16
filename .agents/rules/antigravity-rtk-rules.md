# RTK - Rust Token Killer (Google Antigravity)

**Usage**: Token-optimized CLI proxy for shell commands.

## Rule

Always prefix shell commands with `rtk` to minimize token consumption.

Examples:

```bash
rtk git status
rtk cargo test
rtk ls src/
rtk grep "pattern" src/
rtk find "*.rs" .
rtk docker ps
rtk gh pr list
```

## Meta Commands

```bash
rtk gain              # Show token savings
rtk gain --history    # Command history with savings
rtk discover          # Find missed RTK opportunities
rtk proxy <cmd>       # Run raw (no filtering, for debugging)
```

## Why

RTK filters and compresses command output before it reaches the LLM context, saving 60-90% tokens on common operations. Always use `rtk <cmd>` instead of raw commands.

## Safety & Permissions

To ensure security and workspace isolation, follow these permission rules (mirrored from Claude settings):

### Allowed Bash Commands
- `npx tsc *`
- `pip install *`
- `docker compose *`
- Common read-only actions: `ls`, `cat`, `grep`, `find`, `git`, `pwd`, `stat`, `du`, `df`, `which`, `ps`, `echo`, `head`, `tail`, `wc`, `sort`, `uniq`, `diff`, `file`, `whoami`, `hostname`, `uname`, `date`, `id`, `uptime`, `free`.
- **Restricted `rm`**: Only allowed within the workspace (`/home/ikarin/Trust-Agent/`).

### Denied Actions
- **Path Traversal**: Never use `..` to navigate outside the workspace.
- **System Access**: Do not access `/etc`, `/root`, `/var`, `/usr`, `/bin`, `/sbin`, `/sys`, `/proc`, `/dev`, `/boot`.
- **Sensitive User Data**: Do not access `~/.ssh`, `~/.aws`, `~/.config`, `~/.local`, or shell config files (`.bashrc`, `.zshrc`, etc.).

Always wrap these commands in `rtk` where possible to maintain token efficiency.
