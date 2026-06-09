# pugs-sync-agent — GOALS

**What this is:** a tiny background service on Connor's Mac bridging local iMessage and the Pugs Sales cloud. Four launchd services: **scanner** (`src/scan.js`, reads new iMessages from `~/Library/Messages/chat.db` every 5min → pushes to pugs-sales), **sender** (`src/send.js`, localhost:7890 → sends iMessages via Messages.app), **poller** (`src/poll.js`, every 5s pulls the outbound queue from pugs-sales → dispatches to sender), **updater** (every 10min `git fetch && merge --ff-only` + reload — this is how Charlie deploys to Connor's Mac unattended). A missed inbound iMessage is a lost lead; a broken updater silently strands the deployment. That is the bar for "high value."

**Highest-value work (target these, in order):**
1. **Scanner reliability** (`src/scan.js`) — a dropped/missed inbound iMessage is a lost lead the operator never sees. **✅ DONE:** chat.db schema checked at startup, webhook retries 3x on 5xx/timeout, pagination tests verify no lead-loss at batch boundaries, message dedup guards against chat-sync edge cases (iCloud backup/sync duplication).
2. **Updater robustness** (updater service + `update.sh`) — if it breaks, Connor's Mac silently goes stale and undeployable. **✅ DONE** (merged #56): git merge and npm install errors are now captured and logged with full diagnostic detail; services never start half-reloaded.
3. **Send-queue idempotency** (`src/poll.js`, outbound-queue ack/mark, `MAX_ATTEMPTS`) — a double-mark or lost ack causes a double-send or wrong-recipient, a **client-comms error**. **✅ DONE** (PRs #54/#55): dedup guard pre-seeded from dispatch journal, within-batch dedup tests, journal-persistence across crashes, no double-send path possible.
4. **Error surfacing across all four services** — swallowed errors in scan/send/poll/update that fail silently. **✅ DONE:** all services log to `*.log` and `*.error.log` (configured in launchd plists); init-guard regressions now tested (PR #57).
5. **Tests/guards for the chat.db query, the highwater cursor, and the queue ack logic** — the load-bearing logic, not the plumbing. **✅ MOSTLY DONE:** pagination tested (no off-by-one), cursor correctness verified across batch boundaries, journal and dedup logic fully tested, init-guards now tested.

**Steer away from (busy-work):** polishing `install.sh`/`uninstall.sh`/README install steps, reformatting the `*_INSTRUCTIONS.md` files, padding tests on inert helpers, reflowing log lines. Do not add hygiene tests where no inbound lead or deploy path flows through.

**Bias:** one substantive, well-scoped fix to a real lead-loss or deploy-stall risk beats several small coverage PRs. Honest scope, verbatim test output, branch from clean main. Anything that sends or alters a message is human-floor — stop and flag, don't ship.

## This is a living document
Update it whenever a priority here is resolved, a new risk emerges, or the product's focus shifts — a stale goal misdirects the autonomous loop. Both Charlie and the fleet keep it current; the fleet reviews and refreshes it periodically (and any agent that finishes a listed priority should propose striking it).
