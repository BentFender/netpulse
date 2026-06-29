"""
NetPulse — internet speed & uptime logger.

Runs periodic speedtests (download/upload/ping) plus lightweight ping checks,
stores results in SQLite, and serves a JSON API + static dashboard.
"""
import json
import math
import os
import sqlite3
import subprocess
import threading
import time
from contextlib import closing
from datetime import datetime, timezone, timedelta

from flask import Flask, jsonify, request, send_from_directory

DB_PATH = os.environ.get("NETPULSE_DB", "/data/netpulse.db")
SPEEDTEST_INTERVAL_MIN = int(os.environ.get("SPEEDTEST_INTERVAL_MIN", "30"))
PING_INTERVAL_SEC = int(os.environ.get("PING_INTERVAL_SEC", "60"))
PING_HOST = os.environ.get("PING_HOST", "1.1.1.1")
PING_TIMEOUT_SEC = int(os.environ.get("PING_TIMEOUT_SEC", "5"))
FRONTEND_DIR = os.environ.get("NETPULSE_FRONTEND_DIR", "/frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")

_db_lock = threading.Lock()
_speedtest_in_progress = threading.Lock()


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(get_conn()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                up INTEGER NOT NULL,
                latency_ms REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS speedtests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                up INTEGER NOT NULL,
                download_mbps REAL,
                upload_mbps REAL,
                ping_ms REAL,
                server_name TEXT,
                error TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pings_ts ON pings(ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_speedtests_ts ON speedtests(ts)")
        conn.commit()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Scheduling helpers
# ---------------------------------------------------------------------------

def sleep_until_next_boundary(interval_sec):
    """Sleep until the next wall-clock boundary that's a multiple of
    interval_sec seconds since the Unix epoch (UTC).

    This keeps checks aligned to clean clock marks (e.g. every :00 for a
    60s interval, or :00/:15/:30/:45 for a 15-minute interval) regardless
    of when the process started or how long the previous check took. The
    target time is computed from the absolute clock rather than relative
    to "now + interval", so there's no cumulative drift across restarts
    or slow runs.

    If a check takes longer than interval_sec, the next boundary is
    simply in the past relative to "now" by the time we get back here —
    math.ceil still finds the *next* future boundary, so we skip ahead
    cleanly instead of firing immediately (which would just resume
    drifting) or stacking up missed runs.
    """
    now = time.time()
    next_tick = math.ceil(now / interval_sec) * interval_sec
    sleep_for = next_tick - now
    if sleep_for > 0:
        time.sleep(sleep_for)


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------

def do_ping_check():
    """Lightweight ICMP ping to detect up/down + latency between full speedtests."""
    up = False
    latency = None
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(PING_TIMEOUT_SEC), PING_HOST],
            capture_output=True,
            text=True,
            timeout=PING_TIMEOUT_SEC + 2,
        )
        if result.returncode == 0:
            up = True
            for line in result.stdout.splitlines():
                if "time=" in line:
                    try:
                        latency = float(line.split("time=")[1].split()[0].replace("ms", ""))
                    except (IndexError, ValueError):
                        pass
    except Exception:
        up = False

    with _db_lock, closing(get_conn()) as conn:
        conn.execute(
            "INSERT INTO pings (ts, up, latency_ms) VALUES (?, ?, ?)",
            (now_iso(), 1 if up else 0, latency),
        )
        conn.commit()


SPEEDTEST_BIN = os.environ.get("SPEEDTEST_BIN", "speedtest")
SPEEDTEST_TIMEOUT_SEC = int(os.environ.get("SPEEDTEST_TIMEOUT_SEC", "120"))


def do_speedtest():
    """Run a full speedtest (download/upload/ping) via the official Ookla CLI binary.

    Uses subprocess + JSON output rather than the old `speedtest-cli` Python
    package, which was archived by its author and may stop working as
    speedtest.net's protocol evolves.

    Guarded by a non-blocking lock: if a speedtest is already running (either
    the scheduled one or a manually-triggered one), this call returns
    immediately without starting a second, competing test.
    """
    if not _speedtest_in_progress.acquire(blocking=False):
        return  # one already running; don't compete for bandwidth

    try:
        ts = now_iso()
        try:
            result = subprocess.run(
                [
                    SPEEDTEST_BIN,
                    "--accept-license",
                    "--accept-gdpr",
                    "--format=json",
                ],
                capture_output=True,
                text=True,
                timeout=SPEEDTEST_TIMEOUT_SEC,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"speedtest exited {result.returncode}: {result.stderr.strip()[:300]}"
                )

            data = json.loads(result.stdout)
            # bandwidth is in bytes/sec in Ookla's JSON; convert to Mbps (megabits/sec)
            download_mbps = data["download"]["bandwidth"] * 8 / 1_000_000
            upload_mbps = data["upload"]["bandwidth"] * 8 / 1_000_000
            ping_ms = data["ping"]["latency"]
            server = data.get("server", {})
            server_name = f"{server.get('name', '?')} ({server.get('location', '?')})"

            with _db_lock, closing(get_conn()) as conn:
                conn.execute(
                    """INSERT INTO speedtests
                       (ts, up, download_mbps, upload_mbps, ping_ms, server_name, error)
                       VALUES (?, 1, ?, ?, ?, ?, NULL)""",
                    (ts, download_mbps, upload_mbps, ping_ms, server_name),
                )
                conn.commit()

        except Exception as e:
            with _db_lock, closing(get_conn()) as conn:
                conn.execute(
                    """INSERT INTO speedtests
                       (ts, up, download_mbps, upload_mbps, ping_ms, server_name, error)
                       VALUES (?, 0, NULL, NULL, NULL, NULL, ?)""",
                    (ts, str(e)[:500]),
                )
                conn.commit()
    finally:
        _speedtest_in_progress.release()


def ping_loop():
    # Aligns every check to the next clean wall-clock boundary (e.g. every
    # :00 second of the minute for the default 60s interval) instead of
    # sleeping a fixed duration after each run, so checks never drift off
    # the minute mark regardless of when the app started or how long a
    # check took.
    while True:
        sleep_until_next_boundary(PING_INTERVAL_SEC)
        do_ping_check()


def speedtest_loop():
    # Run one immediately on startup so the dashboard isn't empty.
    do_speedtest()
    interval_sec = SPEEDTEST_INTERVAL_MIN * 60
    while True:
        sleep_until_next_boundary(interval_sec)
        do_speedtest()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.route("/api/status")
def api_status():
    with closing(get_conn()) as conn:
        row = conn.execute(
            "SELECT ts, up, latency_ms FROM pings ORDER BY id DESC LIMIT 1"
        ).fetchone()
        last_speed = conn.execute(
            """SELECT ts, up, download_mbps, upload_mbps, ping_ms, server_name, error
               FROM speedtests ORDER BY id DESC LIMIT 1"""
        ).fetchone()

    status = {
        "last_ping": None,
        "last_speedtest": None,
        "config": {
            "speedtest_interval_min": SPEEDTEST_INTERVAL_MIN,
            "ping_interval_sec": PING_INTERVAL_SEC,
            "ping_host": PING_HOST,
        },
    }
    if row:
        status["last_ping"] = {"ts": row[0], "up": bool(row[1]), "latency_ms": row[2]}
    if last_speed:
        status["last_speedtest"] = {
            "ts": last_speed[0],
            "up": bool(last_speed[1]),
            "download_mbps": last_speed[2],
            "upload_mbps": last_speed[3],
            "ping_ms": last_speed[4],
            "server_name": last_speed[5],
            "error": last_speed[6],
        }
    return jsonify(status)


@app.route("/api/uptime")
def api_uptime():
    """Uptime % and heatmap-friendly bucketed ping data over a given window.

    For large windows, raw per-ping points are bucketed server-side so the
    response stays small regardless of how long the monitor has been running.
    Pass max_points=0 to force raw (unbucketed) output.
    """
    hours = float(request.args.get("hours", "24"))
    max_points = int(request.args.get("max_points", "720"))
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

    with closing(get_conn()) as conn:
        rows = conn.execute(
            "SELECT ts, up, latency_ms FROM pings WHERE ts >= ? ORDER BY ts ASC",
            (since,),
        ).fetchall()

    total = len(rows)
    up_count = sum(1 for r in rows if r[1] == 1)
    uptime_pct = (up_count / total * 100) if total else None

    if max_points and total > max_points:
        bucket_size = math.ceil(total / max_points)
        points = []
        for i in range(0, total, bucket_size):
            chunk = rows[i : i + bucket_size]
            any_down = any(r[1] == 0 for r in chunk)
            latencies = [r[2] for r in chunk if r[2] is not None]
            avg_latency = sum(latencies) / len(latencies) if latencies else None
            points.append({
                "ts": chunk[-1][0],
                "up": not any_down,
                "latency_ms": avg_latency,
                "bucket_size": len(chunk),
            })
    else:
        points = [{"ts": r[0], "up": bool(r[1]), "latency_ms": r[2], "bucket_size": 1} for r in rows]

    return jsonify({
        "hours": hours,
        "total_checks": total,
        "up_checks": up_count,
        "uptime_pct": uptime_pct,
        "points": points,
    })


@app.route("/api/speedhistory")
def api_speedhistory():
    hours = float(request.args.get("hours", "168"))  # default 7 days
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

    with closing(get_conn()) as conn:
        rows = conn.execute(
            """SELECT ts, up, download_mbps, upload_mbps, ping_ms, server_name, error
               FROM speedtests WHERE ts >= ? ORDER BY ts ASC""",
            (since,),
        ).fetchall()

    points = [
        {
            "ts": r[0],
            "up": bool(r[1]),
            "download_mbps": r[2],
            "upload_mbps": r[3],
            "ping_ms": r[4],
            "server_name": r[5],
            "error": r[6],
        }
        for r in rows
    ]
    return jsonify({"hours": hours, "points": points})


@app.route("/api/summary")
def api_summary():
    """Aggregate stats for headline numbers."""
    windows = {"24h": 24, "7d": 24 * 7, "30d": 24 * 30}
    out = {}
    with closing(get_conn()) as conn:
        for label, hrs in windows.items():
            since = (datetime.now(timezone.utc) - timedelta(hours=hrs)).isoformat()
            ping_rows = conn.execute(
                "SELECT up FROM pings WHERE ts >= ?", (since,)
            ).fetchall()
            total = len(ping_rows)
            up_count = sum(1 for r in ping_rows if r[0] == 1)
            uptime_pct = (up_count / total * 100) if total else None

            speed_agg = conn.execute(
                """SELECT AVG(download_mbps), AVG(upload_mbps), AVG(ping_ms),
                          MIN(download_mbps), MAX(download_mbps)
                   FROM speedtests WHERE ts >= ? AND up = 1""",
                (since,),
            ).fetchone()

            out[label] = {
                "uptime_pct": uptime_pct,
                "total_checks": total,
                "avg_download_mbps": speed_agg[0],
                "avg_upload_mbps": speed_agg[1],
                "avg_ping_ms": speed_agg[2],
                "min_download_mbps": speed_agg[3],
                "max_download_mbps": speed_agg[4],
            }
    return jsonify(out)


@app.route("/api/run-speedtest-now", methods=["POST"])
def api_run_speedtest_now():
    if _speedtest_in_progress.locked():
        return jsonify({"started": False, "reason": "A speedtest is already running."})
    threading.Thread(target=do_speedtest, daemon=True).start()
    return jsonify({"started": True})


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


def main():
    init_db()
    threading.Thread(target=ping_loop, daemon=True).start()
    threading.Thread(target=speedtest_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=8077)


if __name__ == "__main__":
    main()
