# NetPulse — internet speed & uptime logger

A self-hosted dashboard that runs real speedtests on a schedule, pings
continuously to track uptime, and shows the history as graphs you can
actually reflect on — not just a live number that resets every refresh. **Not something you want to use on metered connection - it uses over 28GB of traffic dayly on default settings!!!**

<img width="871" height="1348" alt="Screenshot_20260629_211352" src="https://github.com/user-attachments/assets/76d454ef-03e8-46aa-a10f-a79d98ae5e19" />

- **Full speedtest** (download/upload/ping) on a timer — every 10 min by default
- **Lightweight ping check** every 60s for fine-grained uptime tracking
- **7-day outage heatmap** — one cell per check, green/amber/red
- **Speed history chart** (1h / 6h / 12h/ 24h / 7d / 30d) and **latency history chart** (1h / 6h / 12h/ 24h / 7d / 30d)
- **Average values and max deviations clearly represented on the chart**
- All data lives in a local SQLite file, so history survives container restarts
- "Run speedtest now" button for an on-demand check
---
*All coding work made by free access ClaudeAI because I have no coding experience just needed a tool. Testing done on my home ZimaOS server and work UbuntuPi server with CasaOS overlay with help of ClaudeAI.

---

## Deploying on ZimaOS or CasaOS (Installation)

The image is pre-built and published to GHCR by this repo's GitHub Actions
workflow — `ghcr.io/bentfender/netpulse:latest`. ZimaOS or CasaOS just pulls it, no
local build step needed.

### Option A — ZimaOS/CasaOS App Store / Compose UI (recommended)

1. In ZimaOS/CasaOS, choose **Install a customized app** - The **+** simbol on Apps dashboard.
   **Import** — a button with arrow in the top-right corner of the popup settings window.
2. Paste the following into the compose field, **replacing the hostname**
   `192.168.50.227` with your own ZimaOS/CasaOS server's IP address:

   ```yaml
   services:
     netpulse:
       image: ghcr.io/bentfender/netpulse:latest
       container_name: netpulse
       restart: unless-stopped
       network_mode: host   # most reliable for accurate speedtests/pings; see below for bridge-mode alternative
       volumes:
         - /DATA/AppData/netpulse/data:/data
       environment:
         - SPEEDTEST_INTERVAL_MIN=10   # how often to run a full speedtest
         - PING_INTERVAL_SEC=60        # how often to ping for uptime
         - PING_HOST=1.1.1.1           # host to ping for uptime checks

   x-casaos:
     hostname: "192.168.50.227"
     scheme: http
     index: /
     port_map: "8077"
     author: self
     category: self
     icon: "https://raw.githubusercontent.com/BentFender/netpulse/main/netpulse_icon.svg"
     title:
       custom: "netpulse"
   ```

3. Click **Submit** / **Install**. It pulls the image (no build), so this
   should take seconds, not minutes.
4. Open directly from **ZimaOS/CasaOS dashboard** or `http://<your-zimaos-ip>:8077` in a browser.

`network_mode: host` is the most reliable option for accurate ping/speedtest
results and needs no port mapping. If your ZimaOS/CasaOS setup doesn't like host
networking (some app-store UIs prefer explicit ports), use the bridge-mode
version instead:

```yaml
services:
  netpulse:
    image: ghcr.io/bentfender/netpulse:latest
    container_name: netpulse
    restart: unless-stopped
    ports:
      - "8077:8077"
    volumes:
      - /DATA/AppData/netpulse/data:/data
    environment:
      - SPEEDTEST_INTERVAL_MIN=30
      - PING_INTERVAL_SEC=60
      - PING_HOST=1.1.1.1
```

### Option B — SSH / command line

```bash
docker run -d \
  --name netpulse \
  --network host \
  --restart unless-stopped \
  -v /DATA/AppData/netpulse/data:/data \
  -e SPEEDTEST_INTERVAL_MIN=10 \
  -e PING_INTERVAL_SEC=60 \
  -e PING_HOST=1.1.1.1 \
  ghcr.io/bentfender/netpulse:latest
```

Check it's running:

```bash
docker logs -f netpulse
```

Then visit `http://<your-zimaos-ip>:8077`.

### Updating to a new image version

Whenever the GitHub Actions workflow rebuilds `:latest` (after a push to
`main`), pull the new image and recreate the container:

```bash
docker pull ghcr.io/bentfender/netpulse:latest
docker stop netpulse && docker rm netpulse
# then re-run the docker run command above, or re-deploy via the ZimaOS UI
```

---

## Configuration

Set these as environment variables (already wired up in `docker-compose.yml`):

| Variable | Default | What it does |
|---|---|---|
| `SPEEDTEST_INTERVAL_MIN` | `30` | Minutes between full speedtests |
| `PING_INTERVAL_SEC` | `60` | Seconds between lightweight uptime pings |
| `PING_HOST` | `1.1.1.1` | Host pinged for uptime checks |

Full speedtests use real bandwidth (a few hundred MB each, depending on your
connection speed), so if you're on a metered or capped connection, raise
`SPEEDTEST_INTERVAL_MIN` (e.g. to `60` or `120`).

Data is stored in `./data/netpulse.db` (mounted as a volume), so it survives
`docker compose down` / rebuilds. To reset all history, stop the container and
delete that file.

---

## How it works

- **Backend**: Python + Flask. Two background threads run independently of the
  web server — one does ICMP pings on a short interval, the other shells out to
  the official **Ookla Speedtest CLI** binary on a longer interval and parses
  its JSON output. Both write to a local SQLite database (WAL mode, so reads
  and writes don't block each other). The Ookla binary is used instead of the
  older `speedtest-cli` Python package, which was archived by its maintainer
  in January 2026 and will stop receiving fixes if Speedtest.net's protocol
  changes.
- **Frontend**: a single static dashboard (HTML/CSS/vanilla JS) that polls a
  small JSON API (`/api/status`, `/api/summary`, `/api/uptime`,
  `/api/speedhistory`) every 30 seconds and redraws the charts.
- **No external dependencies at runtime** beyond what's installed in the image
  — no cloud service, no telemetry, everything stays on your server.
- **Scales to long-term use**: the dashboard's API automatically buckets
  ping history into a fixed number of points for charts and the heatmap, so
  response sizes stay small (tens of KB) even after months of continuous
  60-second pings. The underlying SQLite file stays compact too — roughly
  10–15 MB for two months of ping + speedtest history.

## Troubleshooting

- **Speedtest errors in the dashboard ("Speedtest failed")**: speedtest-cli
  occasionally can't reach Ookla's server list, or a particular test server is
  down. It'll just retry on the next scheduled run; transient failures are
  normal and the ping-based uptime tracking is unaffected.
- **Uptime shows as low even though your internet seems fine**: check
  `PING_HOST` — some networks block ICMP to certain IPs. Try `8.8.8.8` as an
  alternative.
- **Port conflict on 8077**: change the host-side port in
  `docker-compose.bridge.yml` (e.g. `"8080:8077"`) and adjust the URL you visit
  accordingly.
- **Speedtest CLI license**: the container uses Ookla's official Speedtest CLI
  binary, licensed for personal/non-commercial use. The app passes
  `--accept-license --accept-gdpr` automatically so it never blocks on an
  interactive prompt.
Done
I also notice you already have a "NetPulse — Connection..." tab open in your browser — looks like your install actually worked already! While you're fixing the README, it'd be worth confirming that.



