# Running Zinester on an always-on box

For a daily reading habit, run the server on a machine that's always on — a
Raspberry Pi, a mini-PC, or a NAS. Your feeds, ingested items, notes, and saved
zines live in one data directory on that box; you read from your laptop or phone
over your home network.

> The **editor** works anywhere (browser-only, offline, or on the ESP32). The
> **Reader** needs this persistent server because it fetches feeds and stores
> your queue. This guide sets up both, running as a service.

## 1. Prerequisites

- Node.js **18+** (`node --version`). On Debian/Raspberry Pi OS:
  `sudo apt install nodejs` (or nodesource for a current version).
- Git. No npm dependencies to install — Zinester is built-ins only.

## 2. Clone

```bash
sudo git clone https://github.com/zekefiddler/zinester /opt/zinester
sudo useradd --system --home /opt/zinester zinester   # a dedicated service user
sudo chown -R zinester:zinester /opt/zinester
```

## 3. Install the service

```bash
sudo cp /opt/zinester/deploy/zinester.service /etc/systemd/system/
# (optional) Claude summaries + other env:
sudo cp /opt/zinester/deploy/zinester.env.example /etc/zinester.env
sudo nano /etc/zinester.env        # add ANTHROPIC_API_KEY if you want AI summaries
sudo systemctl daemon-reload
sudo systemctl enable --now zinester
systemctl status zinester          # should be "active (running)"
```

The unit's `StateDirectory=zinester` creates and owns **`/var/lib/zinester`** —
that's your persistent store (`/var/lib/zinester/reader/*.json` = feeds, items,
notes; `/var/lib/zinester/projects` = saved zines). It survives restarts and
`git pull` updates. **Back up that one directory** and you've backed up
everything.

Now open **`http://<box-ip>:8787/reader.html`** from any device on your network.
(Find the IP with `hostname -I`.) The editor is at `/`, the Reader at
`/reader.html`.

### Reading from your phone when you're out

Put [Tailscale](https://tailscale.com) on the box and your phone; then the box
is reachable at its Tailscale IP from anywhere, no ports opened to the internet.

## 4. Daily auto-ingest (feeds)

Any newsletter that publishes an RSS/Atom feed can be pulled automatically — no
credentials, no email parsing. Enable the daily timer:

```bash
sudo cp /opt/zinester/deploy/zinester-refresh.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zinester-refresh.timer
systemctl list-timers zinester-refresh    # see the next run (default 06:00)
```

It runs `tools/refresh.mjs`, which hits `POST /api/reader/refresh`. Change the
time in `zinester-refresh.timer` (`OnCalendar=`) to taste. Most of what lands in
your inbox has a feed — subscribe to the feed in the Reader and you never touch
email for it. A starter set (`reader/seed-feeds.json`) is pre-loaded on first
run; add more with the **＋ Feed** box.

## 5. Newsletters that are email-only

A few newsletters have no public feed. For those, push the email into the same
queue via `POST /api/reader/items` (it gets summarized like a feed item):

```bash
curl -X POST http://<box-ip>:8787/api/reader/items -H 'content-type: application/json' -d '{
  "title":"…", "url":"…", "source":"…", "author":"…",
  "content":"<the article text or HTML>" }'
```

Two ways to automate the push on your box:

- **IMAP + app password (self-contained).** A small script logs into Gmail via
  IMAP with an [app password](https://support.google.com/accounts/answer/185833),
  reads recent messages from your newsletter senders, and POSTs them. Everything
  stays on your box. *(Not included yet — ask and I'll add a `tools/` ingester;
  note it needs testing against a live mailbox, which I can't do from the build
  environment.)*
- **A scheduled assistant run.** A Claude routine with Gmail access pulls new
  newsletters, summarizes, and POSTs to the box (reachable via Tailscale). Good
  if you'd rather not put mail credentials on the box.

Prefer a feed whenever one exists — the content is cleaner and there's no auth.

## 6. Updating

```bash
cd /opt/zinester && sudo -u zinester git pull && sudo systemctl restart zinester
```

Your `/var/lib/zinester` data is untouched by updates.

## NAS note

If your NAS runs Docker instead of systemd, run the same command
(`node server/server.mjs --port 8787 --data /data`) in a Node 18+ container with
`/var/lib/zinester` bind-mounted to `/data` and port 8787 published. The server
is a single zero-dependency process, so any `node:18-alpine`-style image works.
