# Self-hosting

One Node process, one SQLite file. Anything that can run Node 20 and reach the internet can host this bot: a $4 VPS, a Raspberry Pi, a container platform.

## Sizing

The bot is light. It processes several hundred swaps per minute on one core with well under 512 MB of RSS, and SQLite grows slowly because minute buckets are pruned beyond the baseline horizon. Any small instance is enough.

The one thing that matters is **staying up**: baselines rebuild from a 70-minute backfill on restart, so restarts cost about a minute of catch-up, but the per-chat settings, watchlists, and scorecard history all live in SQLite and survive.

## Docker

The repo ships a production Dockerfile:

```bash
git clone https://github.com/nirholas/robinhood-volume-alerts.git
cd robinhood-volume-alerts
docker build -t hood-alerts .
docker run -d --name hood-alerts \
  --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN=1234567890:AAF... \
  -v hood-alerts-data:/app/data \
  hood-alerts
```

The volume mount is the part you must not skip: `/app/data` holds the SQLite database, and without it every container recreation wipes subscriber settings and scorecard history.

## systemd

```ini
# /etc/systemd/system/hood-alerts.service
[Unit]
Description=Robinhood Chain volume alerts bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hoodalerts
WorkingDirectory=/opt/hood-alerts
ExecStartPre=/usr/bin/env robinhood-volume-alerts doctor
ExecStart=/usr/bin/env robinhood-volume-alerts start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -m -d /opt/hood-alerts hoodalerts
sudo -u hoodalerts bash -c 'cd /opt/hood-alerts && npm install -g robinhood-volume-alerts && printf "TELEGRAM_BOT_TOKEN=...\n" > .env'
sudo systemctl enable --now hood-alerts
journalctl -u hood-alerts -f
```

`ExecStartPre` running `doctor` means a broken config refuses to start with a readable reason instead of crash-looping.

## Updating

```bash
npm update -g robinhood-volume-alerts
sudo systemctl restart hood-alerts   # or docker rebuild
```

The database schema migrates itself forward on startup; downgrades are not supported.

## Backups

Everything worth keeping is one file (plus its WAL sidecars):

```bash
sqlite3 /app/data/volume-alerts.db "VACUUM INTO '/backups/alerts-$(date +%F).db'"
```

`VACUUM INTO` is safe while the bot is running.

## Logs

The bot logs JSON lines to stdout (pino). Point them wherever your platform collects stdout; `LOG_LEVEL=debug` when investigating, `info` otherwise. A `pipeline stats` line prints once a minute with trade and alert counters, which makes silent stalls visible at a glance.
