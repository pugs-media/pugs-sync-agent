# pugs-sync-agent — GOALS

**What this is:** a tiny background service on Connor's Mac bridging local iMessage and the Pugs Sales cloud. Four launchd services: **scanner** (`src/scan.js`, reads new iMessages from `~/Library/Messages/chat.db` every 5min → pushes to pugs-sales), **sender** (`src/send.js`, localhost:7890 → sends iMessages via Messages.app), **poller** (`src/poll.js`, every 5s pulls the outbound queue from pugs-sales → dispatches to sender), **updater** (every 10min `git fetch && merge --ff-only` + reload — this is how Charlie deploys to Connor's Mac unattended). A missed inbound iMessage is a lost lead; a broken updater silently strands the deployment. That is the bar for "high value."

**Highest-value work (target these, in order):**
1. **Scanner reliability** (`src/scan.js`) — a dropped/missed inbound iMessage is a lost lead the operator never sees. Harden the chat.db read (cursor/highwater-mark correctness so messages aren't skipped or re-sent), webhook retry on transient 5xx/timeout, and the macOS-upgrade chat.db schema risk.
2. **Updater robustness** (updater service + `update.sh`) — if it breaks, Connor's Mac silently goes stale and undeployable. Make pull failures (conflicts, dirty tree, failed `npm install`) loud in the updater log, recover cleanly, and never leave services half-reloaded.
3. **Send-queue idempotency** (`src/poll.js`, outbound-queue ack/mark, `MAX_ATTEMPTS`) — a double-mark or lost ack causes a double-send or wrong-recipient, a **client-comms error**. Harden the dedup/ack path + guards. **HUMAN-FLOOR: never make the loop actually send, change a recipient, or alter outbound content; only harden the guard + tests. Double-send is a thing to guard against, not to reproduce by sending.**
4. **Error surfacing across all four services** — swallowed errors in scan/send/poll/update that fail silently. Surface them to the documented logs (`scanner.log`/`sender.log`/`poller.log`/`updater.log`) so a stalled service is diagnosable.
5. Tests/guards for the chat.db query, the highwater cursor, and the queue ack logic — the load-bearing logic, not the plumbing.

**Steer away from (busy-work):** polishing `install.sh`/`uninstall.sh`/README install steps, reformatting the `*_INSTRUCTIONS.md` files, padding tests on inert helpers, reflowing log lines. Do not add hygiene tests where no inbound lead or deploy path flows through.

**Bias:** one substantive, well-scoped fix to a real lead-loss or deploy-stall risk beats several small coverage PRs. Honest scope, verbatim test output, branch from clean main. Anything that sends or alters a message is human-floor — stop and flag, don't ship.

## This is a living document
Update it whenever a priority here is resolved, a new risk emerges, or the product's focus shifts — a stale goal misdirects the autonomous loop. Both Charlie and the fleet keep it current; the fleet reviews and refreshes it periodically (and any agent that finishes a listed priority should propose striking it).
