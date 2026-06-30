const REFRESH_MS = 30_000;

const el = (id) => document.getElementById(id);

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function relTime(isoStr) {
  if (!isoStr) return "—";
  const then = new Date(isoStr);
  const now = new Date();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// ---------------- Status pill + headline metrics ----------------
async function refreshStatus() {
  try {
    const data = await fetchJSON("/api/status");

    const pill = el("statusPill");
    const text = pill.querySelector(".status-text");
    pill.classList.remove("status-pill--up", "status-pill--down", "status-pill--loading");

    if (data.last_ping) {
      if (data.last_ping.up) {
        pill.classList.add("status-pill--up");
        text.textContent = "Online";
      } else {
        pill.classList.add("status-pill--down");
        text.textContent = "Offline";
      }
      el("lastPingTime").textContent = `checked ${relTime(data.last_ping.ts)}`;
    } else {
      text.textContent = "No data yet";
    }

    const sp = data.last_speedtest;
    if (sp && sp.up) {
      el("curDownload").textContent = fmtNum(sp.download_mbps);
      el("curUpload").textContent = fmtNum(sp.upload_mbps);
      el("curPing").textContent = fmtNum(sp.ping_ms, 0);
      el("curServer").textContent = sp.server_name || "Unknown";
      el("lastSpeedTime").textContent = relTime(sp.ts);

      el("downloadBar").style.width = `${Math.min(100, (sp.download_mbps / 500) * 100)}%`;
      el("uploadBar").style.width = `${Math.min(100, (sp.upload_mbps / 500) * 100)}%`;
      el("pingBar").style.width = `${Math.min(100, 100 - (sp.ping_ms / 200) * 100)}%`;
    } else if (sp && !sp.up) {
      el("curDownload").textContent = "—";
      el("curUpload").textContent = "—";
      el("curPing").textContent = "—";
      el("curServer").textContent = "Speedtest failed";
      el("curServerSub").textContent = sp.error ? sp.error.slice(0, 60) : "";
      el("lastSpeedTime").textContent = relTime(sp.ts);
      el("downloadBar").style.width = "0%";
      el("uploadBar").style.width = "0%";
      el("pingBar").style.width = "0%";
    }

    const cfg = data.config;
    el("footerConfig").textContent =
      `Pinging ${cfg.ping_host} every ${cfg.ping_interval_sec}s · full speedtest every ${cfg.speedtest_interval_min}min`;
  } catch (e) {
    console.error("status refresh failed", e);
  }
}

// ---------------- Headline uptime numbers ----------------
async function refreshSummary() {
  try {
    const data = await fetchJSON("/api/summary");
    const h24 = data["24h"];
    const d7 = data["7d"];
    const d30 = data["30d"];

    if (h24 && h24.uptime_pct !== null) {
      el("uptime24h").innerHTML = `${fmtNum(h24.uptime_pct)}<span class="unit">%</span>`;
      el("uptime24hSub").textContent = `${h24.total_checks} checks in the last 24h`;
    } else {
      el("uptime24hSub").textContent = "not enough data yet";
    }

    el("uptime7d").textContent = d7 && d7.uptime_pct !== null ? `${fmtNum(d7.uptime_pct)}%` : "—%";
    el("uptime30d").textContent = d30 && d30.uptime_pct !== null ? `${fmtNum(d30.uptime_pct)}%` : "—%";
  } catch (e) {
    console.error("summary refresh failed", e);
  }
}

// ---------------- Heatmap ----------------
const HEATMAP_DAYS = 7;
const CELLS_PER_DAY = 288;          // 24h * 60min / 5min resolution
const HEATMAP_COLUMNS = 48;         // 288 / 48 = 6 rows per day
const HEATMAP_VISIBLE_DAYS = 3;     // days visible before scrolling

function classifyPing(point) {
  if (!point) return "none";
  if (!point.up) return "down";
  if (point.latency_ms !== null && point.latency_ms > 150) return "slow";
  return "up";
}

function dayKeyLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayLabel(date) {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function groupPointsByDay(points) {
  const byDay = new Map();
  const cellMs = (24 * 60 * 60 * 1000) / CELLS_PER_DAY;

  for (const p of points) {
    const d = new Date(p.ts);
    const key = dayKeyLocal(d);
    if (!byDay.has(key)) {
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      byDay.set(key, { date: dayStart, slots: new Array(CELLS_PER_DAY).fill(null) });
    }
    const entry = byDay.get(key);
    const msIntoDay = d.getTime() - entry.date.getTime();
    let slotIdx = Math.floor(msIntoDay / cellMs);
    slotIdx = Math.max(0, Math.min(CELLS_PER_DAY - 1, slotIdx));
    entry.slots[slotIdx] = p;
  }

  return Array.from(byDay.values())
    .sort((a, b) => a.date - b.date)
    .map((entry) => ({ date: entry.date, cells: entry.slots }));
}

async function refreshHeatmap() {
  try {
    const totalPoints = HEATMAP_DAYS * CELLS_PER_DAY;
    const data = await fetchJSON(`/api/uptime?hours=${HEATMAP_DAYS * 24}&max_points=${totalPoints}`);
    const heatmap = el("heatmap");
    heatmap.innerHTML = "";

    const points = data.points;
    if (points.length === 0) {
      heatmap.innerHTML = `<div style="font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary);">No checks recorded yet — the monitor just started.</div>`;
      return;
    }

    const days = groupPointsByDay(points);

    for (const day of days) {
      const dayGroup = document.createElement("div");
      dayGroup.className = "heatmap-day";

      const label = document.createElement("div");
      label.className = "heatmap-day__label";
      label.textContent = dayLabel(day.date);
      dayGroup.appendChild(label);

      const grid = document.createElement("div");
      grid.className = "heatmap-day__grid";

      for (const p of day.cells) {
        const cls = classifyPing(p);
        const cell = document.createElement("div");
        cell.className = `heatmap-cell heatmap-cell--${cls}`;
        if (p) {
          const countNote = p.bucket_size > 1 ? ` (${p.bucket_size} checks)` : "";
          cell.title = `${new Date(p.ts).toLocaleString(undefined, { hour12: false })} — ${cls}${countNote}`;
        } else {
          cell.title = "No data";
        }
        grid.appendChild(cell);
      }

      dayGroup.appendChild(grid);
      heatmap.appendChild(dayGroup);
    }

    requestAnimationFrame(() => {
      heatmap.scrollTop = heatmap.scrollHeight;
    });
  } catch (e) {
    console.error("heatmap refresh failed", e);
  }
}

// ---------------- SVG line chart helper ----------------

const TICK_STEPS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  2 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
];

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function pickTickStepMs(spanMs, targetTicks = 6) {
  for (const step of TICK_STEPS_MS) {
    if (spanMs / step <= targetTicks * 1.8) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

function snapToStep(date, stepMs) {
  const t = date.getTime();
  if (stepMs >= MS_PER_DAY) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const days = Math.ceil((t - d.getTime()) / MS_PER_DAY);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }
  const dayStart = new Date(t);
  dayStart.setHours(0, 0, 0, 0);
  const offset = t - dayStart.getTime();
  const snapped = Math.ceil(offset / stepMs) * stepMs;
  return dayStart.getTime() + snapped;
}

function formatTickLabel(ts, stepMs, spanMs) {
  const date = new Date(ts);
  if (stepMs >= MS_PER_DAY) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (spanMs > MS_PER_DAY) {
    const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${dateStr} ${timeStr}`;
  }
  return timeStr;
}

function seriesAverage(points) {
  const vals = points.map((p) => p.value).filter((v) => v !== null && !Number.isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function findStandoutPoints(coordsWithValue, avg, minSpacingPx) {
  if (avg === null) return [];
  const values = coordsWithValue.map((c) => c.value).filter((v) => v !== null && !Number.isNaN(v));
  if (values.length === 0) return [];

  const maxAbsDev = Math.max(...values.map((v) => Math.abs(v - avg)));
  const noiseFloor = Math.max(maxAbsDev * 0.35, avg * 0.05, 1);

  const candidates = coordsWithValue
    .filter((c) => c.value !== null && !Number.isNaN(c.value))
    .map((c) => ({ ...c, deviation: Math.abs(c.value - avg) }))
    .filter((c) => c.deviation >= noiseFloor)
    .sort((a, b) => b.deviation - a.deviation);

  const picked = [];
  for (const c of candidates) {
    const tooClose = picked.some((p) => Math.abs(p.x - c.x) < minSpacingPx);
    if (tooClose) continue;
    picked.push(c);
  }
  return picked;
}

function drawLineChart(svg, series, opts) {
  const { width = 1000, height = 320, padding = { top: 20, right: 16, bottom: 30, left: 50 }, rangeHours = null } = opts;
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const allValues = series.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v !== null && !Number.isNaN(v));

  if (allValues.length === 0) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", width / 2);
    text.setAttribute("y", height / 2);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--text-tertiary)");
    text.setAttribute("font-size", "13");
    text.textContent = "No data yet for this range";
    svg.appendChild(text);
    return;
  }

  const maxVal = Math.max(...allValues) * 1.15 || 1;
  const minVal = 0;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allTs = series.flatMap((s) => s.points.map((p) => new Date(p.ts).getTime()));
  const dataMinTs = Math.min(...allTs);
  const dataMaxTs = Math.max(...allTs);

  let minTs, maxTs;
  if (rangeHours) {
    const rangeMs = rangeHours * 60 * 60 * 1000;
    const overheadMs = Math.max(rangeMs * 0.03, 2 * 60 * 1000);
    const now = Date.now();
    maxTs = Math.max(now, dataMaxTs) + overheadMs;
    minTs = Math.min(now - rangeMs, dataMinTs) - overheadMs;
  } else {
    const span = Math.max(dataMaxTs - dataMinTs, 1);
    const overheadMs = Math.max(span * 0.03, 60 * 1000);
    minTs = dataMinTs - overheadMs;
    maxTs = dataMaxTs + overheadMs;
  }

  const tsSpan = Math.max(maxTs - minTs, 1);
  const xForTs = (ts) => padding.left + ((ts - minTs) / tsSpan) * plotW;

  // gridlines + y-axis labels
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = padding.top + (plotH / gridCount) * i;
    const val = maxVal - (maxVal / gridCount) * i;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "var(--border)");
    line.setAttribute("stroke-width", "1");
    svg.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", padding.left - 10);
    label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", "var(--text-tertiary)");
    label.textContent = Math.round(val);
    svg.appendChild(label);
  }

  // x-axis time ticks
  const stepMs = pickTickStepMs(tsSpan);
  let tickTs = snapToStep(new Date(minTs), stepMs);
  const ticks = [];
  while (tickTs <= maxTs) {
    ticks.push(tickTs);
    tickTs += stepMs;
  }

  for (const t of ticks) {
    const x = xForTs(t);
    const tickLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tickLine.setAttribute("x1", x.toFixed(2));
    tickLine.setAttribute("x2", x.toFixed(2));
    tickLine.setAttribute("y1", padding.top);
    tickLine.setAttribute("y2", height - padding.bottom);
    tickLine.setAttribute("stroke", "var(--border)");
    tickLine.setAttribute("stroke-width", "1");
    tickLine.setAttribute("opacity", "0.5");
    svg.appendChild(tickLine);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x.toFixed(2));
    label.setAttribute("y", height - 8);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", "var(--text-tertiary)");
    label.textContent = formatTickLabel(t, stepMs, tsSpan);
    svg.appendChild(label);
  }

  for (const s of series) {
    const n = s.points.length;
    if (n === 0) continue;

    const coords = s.points.map((p) => {
      const x = xForTs(new Date(p.ts).getTime());
      const y =
        p.value === null || Number.isNaN(p.value)
          ? null
          : padding.top + plotH - ((p.value - minVal) / (maxVal - minVal)) * plotH;
      return { x, y, value: p.value };
    });

    // Build path, breaking on nulls (gaps = downtime / missing data)
    let d = "";
    let drawing = false;
    for (const c of coords) {
      if (c.y === null) {
        drawing = false;
        continue;
      }
      d += drawing ? ` L ${c.x.toFixed(2)} ${c.y.toFixed(2)}` : ` M ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
      drawing = true;
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);

    // dots at data points
    for (const c of coords) {
      if (c.y === null) continue;
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", c.x.toFixed(2));
      dot.setAttribute("cy", c.y.toFixed(2));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", s.color);
      dot.setAttribute("opacity", "0.85");
      svg.appendChild(dot);
    }

    // Average value: dashed reference line across the chart + label.
    // First series (index 0, e.g. Download) → label on the LEFT Y-axis.
    // Second+ series (index 1+, e.g. Upload) → label on the RIGHT edge.
    // Single-series charts (Latency) always use the left.
    const avg = seriesAverage(s.points);
    if (avg !== null) {
      const avgY = padding.top + plotH - ((avg - minVal) / (maxVal - minVal)) * plotH;
      const clampedY = Math.max(padding.top + 6, Math.min(avgY, height - padding.bottom - 4));

      // Dashed reference line at true avg height
      const avgLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      avgLine.setAttribute("x1", padding.left);
      avgLine.setAttribute("x2", width - padding.right);
      avgLine.setAttribute("y1", avgY.toFixed(2));
      avgLine.setAttribute("y2", avgY.toFixed(2));
      avgLine.setAttribute("stroke", s.color);
      avgLine.setAttribute("stroke-width", "1");
      avgLine.setAttribute("stroke-dasharray", "4 3");
      avgLine.setAttribute("opacity", "0.35");
      svg.appendChild(avgLine);

      const avgLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const onRight = series.indexOf(s) > 0;
      if (onRight) {
        // Right side: anchor to the right edge, inside the plot
        avgLabel.setAttribute("x", (width - padding.right + 14).toFixed(2));
        avgLabel.setAttribute("text-anchor", "end");
      } else {
        // Left side: sit just outside the left Y-axis
        avgLabel.setAttribute("x", (padding.left - 10).toFixed(2));
        avgLabel.setAttribute("text-anchor", "end");
      }
      avgLabel.setAttribute("y", (clampedY + 4).toFixed(2));
      avgLabel.setAttribute("font-size", "10");
      avgLabel.setAttribute("font-weight", "600");
      avgLabel.setAttribute("fill", s.color);
      avgLabel.textContent = `avg ${avg < 10 ? avg.toFixed(1) : Math.round(avg)}`;
      svg.appendChild(avgLabel);
    }

    // Standout point labels
    const standouts = findStandoutPoints(coords, seriesAverage(s.points), plotW * 0.09);
    for (const c of standouts) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const avgForStandout = seriesAverage(s.points);
      const isPeak = avgForStandout !== null && c.value > avgForStandout;
      label.setAttribute("x", c.x.toFixed(2));
      label.setAttribute("y", isPeak ? (c.y - 8).toFixed(2) : (c.y + 14).toFixed(2));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "10");
      label.setAttribute("font-weight", "600");
      label.setAttribute("fill", s.color);
      label.textContent = c.value < 10 ? c.value.toFixed(1) : Math.round(c.value);
      svg.appendChild(label);
    }
  }

  // legend
  let lx = padding.left;
  for (const s of series) {
    const swatch = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    swatch.setAttribute("x", lx);
    swatch.setAttribute("y", 4);
    swatch.setAttribute("width", "10");
    swatch.setAttribute("height", "10");
    swatch.setAttribute("rx", "2");
    swatch.setAttribute("fill", s.color);
    svg.appendChild(swatch);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", lx + 16);
    label.setAttribute("y", 13);
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", "var(--text-secondary)");
    label.textContent = s.label;
    svg.appendChild(label);

    lx += s.label.length * 6.5 + 36;
  }
}

// ---------------- Speed history chart ----------------
let currentSpeedHours = 24;
let currentLatHours = 24;

async function refreshSpeedChart() {
  try {
    const data = await fetchJSON(`/api/speedhistory?hours=${currentSpeedHours}`);
    const svg = el("speedChart");

    const downloadSeries = {
      label: "Download",
      color: "var(--signal-blue)".trim(),
      points: data.points.map((p) => ({ ts: p.ts, value: p.up ? p.download_mbps : null })),
    };
    const uploadSeries = {
      label: "Upload",
      color: "#4ECB8F",
      points: data.points.map((p) => ({ ts: p.ts, value: p.up ? p.upload_mbps : null })),
    };
    // resolve CSS var manually since SVG attrs don't resolve var() reliably across all contexts
    downloadSeries.color = "#5B9DFF";

    drawLineChart(svg, [downloadSeries, uploadSeries], { height: 320, rangeHours: currentSpeedHours });
  } catch (e) {
    console.error("speed chart refresh failed", e);
  }
}

async function refreshLatencyChart() {
  try {
    const data = await fetchJSON(`/api/uptime?hours=${currentLatHours}&max_points=400`);
    const svg = el("latencyChart");
    const series = {
      label: "Latency",
      color: "#F0A23A",
      points: data.points.map((p) => ({ ts: p.ts, value: p.up ? p.latency_ms : null })),
    };
    drawLineChart(svg, [series], { height: 240, rangeHours: currentLatHours });
  } catch (e) {
    console.error("latency chart refresh failed", e);
  }
}

// ---------------- Range toggles ----------------
function setupRangeToggle(containerId, onSelect) {
  const container = el(containerId);
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    container.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("range-btn--active"));
    btn.classList.add("range-btn--active");
    onSelect(Number(btn.dataset.hours));
  });
}

setupRangeToggle("speedRangeToggle", (hours) => {
  currentSpeedHours = hours;
  refreshSpeedChart();
});

setupRangeToggle("latRangeToggle", (hours) => {
  currentLatHours = hours;
  refreshLatencyChart();
});

// ---------------- Run speedtest now ----------------
el("runNowBtn").addEventListener("click", async () => {
  const btn = el("runNowBtn");
  const icon = btn.querySelector(".btn-run__icon");
  btn.disabled = true;
  icon.classList.add("btn-run__icon--spinning");
  btn.lastChild.textContent = " Running…";

  try {
    const resp = await fetchJSON("/api/run-speedtest-now", { method: "POST" });
    if (!resp.started) {
      btn.lastChild.textContent = " Already running…";
      setTimeout(() => {
        btn.disabled = false;
        icon.classList.remove("btn-run__icon--spinning");
        btn.lastChild.textContent = " Run speedtest now";
      }, 2500);
      return;
    }

    const startedAt = Date.now();
    const poll = setInterval(async () => {
      await refreshStatus();
      await refreshSummary();
      await refreshSpeedChart();
      if (Date.now() - startedAt > 60_000) clearInterval(poll);
    }, 4000);
    setTimeout(() => clearInterval(poll), 60_000);
  } catch (e) {
    console.error("manual speedtest trigger failed", e);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      icon.classList.remove("btn-run__icon--spinning");
      btn.lastChild.textContent = " Run speedtest now";
    }, 5000);
  }
});

// ---------------- Init ----------------
function refreshAll() {
  refreshStatus();
  refreshSummary();
  refreshHeatmap();
  refreshSpeedChart();
  refreshLatencyChart();
}

refreshAll();
setInterval(refreshAll, REFRESH_MS);
