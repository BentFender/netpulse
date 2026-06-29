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

function classifyPing(point) {
  if (!point) return "none";
  if (!point.up) return "down";
  if (point.latency_ms !== null && point.latency_ms > 150) return "slow";
  return "up";
}

// Local calendar-day key (not UTC) so a day boundary lines up with what the
// person actually sees on a clock, e.g. "2026-06-28".
function dayKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Sub-row boundaries to try, largest chunk (fewest rows per day) first.
// A day only drops to a smaller chunk size if the larger one's row would
// actually overflow the available width at the current cell size — so on
// a wide screen most days stay at 2 rows (12h each), and only cramped
// widths or denser data fall back to 6h/4h splits.
const HEATMAP_SUBROW_HOURS = [12, 6, 4];
const HEATMAP_CELL_PX = 11;
const HEATMAP_GAP_PX = 3;
// These two must match the .heatmap-row__label width and .heatmap-row gap
// in style.css — used to work out how much horizontal space is actually
// left for cells without relying on measuring an (easily zero-width, if
// empty) flex child directly.
const HEATMAP_LABEL_WIDTH_PX = 92;
const HEATMAP_ROW_GAP_PX = 12;

function maxCellsPerLine(availablePx) {
  // n*cell + (n-1)*gap <= available  =>  n <= (available + gap) / (cell + gap)
  return Math.max(1, Math.floor((availablePx + HEATMAP_GAP_PX) / (HEATMAP_CELL_PX + HEATMAP_GAP_PX)));
}

async function refreshHeatmap() {
  try {
    // Server now buckets large ranges down to ~700 points itself, so we
    // just ask for the window and render whatever comes back.
    const data = await fetchJSON("/api/uptime?hours=168&max_points=700");
    const heatmap = el("heatmap");
    heatmap.innerHTML = "";

    const points = data.points;
    if (points.length === 0) {
      heatmap.innerHTML = `<div style="font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary);">No checks recorded yet — the monitor just started.</div>`;
      return;
    }

    // Group points into one bucket per calendar day, oldest day first, so
    // each day renders as its own labeled section instead of one long
    // strip that wraps wherever the browser happens to run out of
    // horizontal space (which made row boundaries meaningless before).
    const byDay = new Map();
    for (const p of points) {
      const key = dayKey(p.ts);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(p);
    }
    const dayKeys = Array.from(byDay.keys()).sort((a, b) => a - b);

    // Figure out how many cells actually fit on one line right now, based
    // on the real rendered width of the heatmap container (not a guessed
    // panel width), so this keeps working if the layout or screen size
    // changes. Measuring the container directly — rather than an empty
    // probe element — avoids a flexbox quirk where a flex child with no
    // content yet can report a width of 0 even though space is available.
    const heatmapWidth = heatmap.getBoundingClientRect().width;
    const availablePx = heatmapWidth - HEATMAP_LABEL_WIDTH_PX - HEATMAP_ROW_GAP_PX;
    const cellsPerLine = maxCellsPerLine(availablePx > 0 ? availablePx : 300);

    for (const key of dayKeys) {
      const dayPoints = byDay.get(key);

      const dayBlock = document.createElement("div");
      dayBlock.className = "heatmap-day";

      // Pick the largest sub-row chunk (fewest rows) whose resulting row
      // width still fits on one line. Falls back to splitting by however
      // many cells actually fit if even a 4h chunk would overflow (e.g. a
      // very narrow screen or unusually dense bucketing).
      let chunks = null;
      for (const hoursPerChunk of HEATMAP_SUBROW_HOURS) {
        const candidate = splitByHourBoundary(dayPoints, key, hoursPerChunk);
        const widestChunk = Math.max(...candidate.map((c) => c.length));
        if (widestChunk <= cellsPerLine) {
          chunks = candidate;
          break;
        }
      }
      if (chunks === null) {
        chunks = [];
        for (let i = 0; i < dayPoints.length; i += cellsPerLine) {
          chunks.push(dayPoints.slice(i, i + cellsPerLine));
        }
      }

      let firstSubRow = true;
      for (const chunk of chunks) {
        if (chunk.length === 0) continue;

        const row = document.createElement("div");
        row.className = "heatmap-row";

        const label = document.createElement("div");
        label.className = "heatmap-row__label";
        label.textContent = firstSubRow ? dayLabel(key) : "";
        row.appendChild(label);
        firstSubRow = false;

        const cellsWrap = document.createElement("div");
        cellsWrap.className = "heatmap-row__cells";
        for (const p of chunk) {
          const cls = classifyPing(p);
          const cell = document.createElement("div");
          cell.className = `heatmap-cell heatmap-cell--${cls}`;
          const countNote = p.bucket_size > 1 ? ` (${p.bucket_size} checks)` : "";
          cell.title = `${new Date(p.ts).toLocaleString(undefined, { hour12: false })} — ${cls}${countNote}`;
          cellsWrap.appendChild(cell);
        }
        row.appendChild(cellsWrap);
        dayBlock.appendChild(row);
      }

      heatmap.appendChild(dayBlock);
    }
  } catch (e) {
    console.error("heatmap refresh failed", e);
  }
}

// Split one day's points into chunks aligned to clock boundaries (e.g.
// 00:00-12:00 / 12:00-24:00 for a 12h split), not just evenly-sized
// slices — so each sub-row corresponds to a real, readable time window.
function splitByHourBoundary(dayPoints, dayStartTs, hoursPerChunk) {
  const chunkMs = hoursPerChunk * 60 * 60 * 1000;
  const numChunks = Math.ceil(24 / hoursPerChunk);
  const chunks = Array.from({ length: numChunks }, () => []);
  for (const p of dayPoints) {
    const offsetMs = new Date(p.ts).getTime() - dayStartTs;
    const idx = Math.min(numChunks - 1, Math.max(0, Math.floor(offsetMs / chunkMs)));
    chunks[idx].push(p);
  }
  return chunks;
}

// ---------------- SVG line chart helper ----------------

// Candidate tick spacings, in milliseconds, ordered smallest to largest.
// We pick the smallest one that still gives a reasonable number of ticks
// across the visible time span, so dense/short ranges get hourly ticks
// and long ranges fall back to daily ticks instead of being unreadable.
const TICK_STEPS_MS = [
  5 * 60 * 1000, // 5 min
  15 * 60 * 1000, // 15 min
  30 * 60 * 1000, // 30 min
  60 * 60 * 1000, // 1 hour
  2 * 60 * 60 * 1000, // 2 hours
  3 * 60 * 60 * 1000, // 3 hours
  6 * 60 * 60 * 1000, // 6 hours
  12 * 60 * 60 * 1000, // 12 hours
  24 * 60 * 60 * 1000, // 1 day
  2 * 24 * 60 * 60 * 1000, // 2 days
  7 * 24 * 60 * 60 * 1000, // 1 week
];

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Pick a tick step that yields roughly `targetTicks` ticks (aiming for
// 5-8) across the given span, then snap tick positions to "nice"
// boundaries (on the hour, every N hours, or midnight) so labels read
// like a real clock/calendar instead of arbitrary offsets.
function pickTickStepMs(spanMs, targetTicks = 6) {
  for (const step of TICK_STEPS_MS) {
    if (spanMs / step <= targetTicks * 1.8) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

function snapToStep(date, stepMs) {
  const t = date.getTime();
  if (stepMs >= MS_PER_DAY) {
    // snap to local midnight boundaries
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const days = Math.ceil((t - d.getTime()) / MS_PER_DAY);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }
  // snap to the next clean boundary of stepMs, anchored to local midnight
  // (so e.g. 2-hour ticks land on 00:00, 02:00, 04:00 ... not 00:37, 02:37)
  const dayStart = new Date(t);
  dayStart.setHours(0, 0, 0, 0);
  const offset = t - dayStart.getTime();
  const snapped = Math.ceil(offset / stepMs) * stepMs;
  return dayStart.getTime() + snapped;
}

function formatTickLabel(ts, stepMs, spanMs) {
  const date = new Date(ts);
  if (stepMs >= MS_PER_DAY) {
    // day-granularity ticks: show the date
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // hour-granularity ticks: show the time, plus the date when the
  // visible span crosses multiple days (so labels stay unambiguous)
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

// Average of a series' non-null values.
function seriesAverage(points) {
  const vals = points.map((p) => p.value).filter((v) => v !== null && !Number.isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Pick all points whose value deviates meaningfully from `avg`, ranked by
// deviation, enforcing a minimum pixel spacing between picks so labels
// never crowd into an unreadable blob. No fixed count — a chart with one
// clear isolated spike gets one label, a chart with several well-separated
// spikes gets several (even if they're not all the same height), and only
// spikes that are genuinely close together on the x-axis get thinned down
// to their tallest member. Separation in time, not relative height, is
// what decides whether a peak earns its own label.
function findStandoutPoints(coordsWithValue, avg, minSpacingPx) {
  if (avg === null) return [];
  const values = coordsWithValue.map((c) => c.value).filter((v) => v !== null && !Number.isNaN(v));
  if (values.length === 0) return [];

  // Noise floor: filters out points that are basically indistinguishable
  // from the average (sensor jitter, rounding), not points that are merely
  // smaller than the single tallest spike in the series. Using a fraction
  // of the tallest spike here would mean one big outlier silently raises
  // the bar for every other (still genuinely significant) peak — exactly
  // what was hiding real spikes that were merely "not the very tallest".
  const noiseFloor = Math.max(avg * 0.15, 3);

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

  // The x-axis span is driven by the SELECTED RANGE (e.g. the 24h button),
  // not by whichever timestamps happen to come back from the API. This
  // way the chart always shows the full requested window — with a little
  // padding on both sides — even if the data only fills part of it (e.g.
  // the monitor hasn't been running that long yet, or there's a gap).
  // Falls back to data-derived span if no rangeHours is given.
  const allTs = series.flatMap((s) => s.points.map((p) => new Date(p.ts).getTime()));
  const dataMinTs = Math.min(...allTs);
  const dataMaxTs = Math.max(...allTs);

  let minTs, maxTs;
  if (rangeHours) {
    const rangeMs = rangeHours * 60 * 60 * 1000;
    const overheadMs = Math.max(rangeMs * 0.03, 2 * 60 * 1000); // ~3% padding each side, min 2 minutes
    const now = Date.now();
    // Anchor the window to "now" looking back rangeHours, but extend to
    // cover the data too in case a point is (slightly) outside that window.
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

  // x-axis time ticks: real, evenly-spaced-in-time gridlines snapped to
  // clean hour/day boundaries, labeled with actual local time/date.
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

  // Average label rows are computed for every series up front (before any
  // drawing) so we know all their natural y-positions at once. That lets us
  // detect collisions between series (e.g. Download/Upload averages sitting
  // close together) and resolve them by nudging the labels apart vertically.
  // The labels themselves live in the y-axis scale column (right-aligned,
  // just left of the gridlines — same spot as the "290 / 217 / 145..."
  // numbers) rather than inside the plot area, so they can never sit on
  // top of the data lines no matter what the values are.
  const avgRows = [];
  for (const s of series) {
    const avg = seriesAverage(s.points);
    if (avg === null) continue;
    const avgY = padding.top + plotH - ((avg - minVal) / (maxVal - minVal)) * plotH;
    avgRows.push({ series: s, avg, y: avgY });
  }
  avgRows.sort((a, b) => a.y - b.y);

  const MIN_LABEL_GAP_PX = 13; // smallest vertical gap that keeps stacked labels readable
  for (let i = 1; i < avgRows.length; i++) {
    const prev = avgRows[i - 1];
    const cur = avgRows[i];
    const gap = cur.y - prev.y;
    if (gap < MIN_LABEL_GAP_PX) {
      const push = (MIN_LABEL_GAP_PX - gap) / 2;
      prev.y -= push;
      cur.y += push;
    }
  }
  // Keep everything inside the plot area after nudging.
  for (const row of avgRows) {
    row.y = Math.max(padding.top + 10, Math.min(row.y, height - padding.bottom - 4));
  }
  const avgYById = new Map(avgRows.map((row) => [row.series, row.y]));

  // Draw the avg labels in the y-axis column now, before the series loop,
  // so they sit visually grouped with the scale numbers rather than mixed
  // in with per-series drawing order.
  for (const [s, avgY] of avgYById) {
    const row = avgRows.find((r) => r.series === s);
    const avgLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    avgLabel.setAttribute("x", padding.left - 10);
    avgLabel.setAttribute("y", avgY.toFixed(2));
    avgLabel.setAttribute("text-anchor", "end");
    avgLabel.setAttribute("font-size", "10");
    avgLabel.setAttribute("font-weight", "600");
    avgLabel.setAttribute("fill", s.color);
    avgLabel.textContent = `avg ${row.avg < 10 ? row.avg.toFixed(1) : Math.round(row.avg)}`;
    svg.appendChild(avgLabel);
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

    const avg = seriesAverage(s.points);

    // Standout point labels: values deviating most from average (covers
    // both spikes above and dips below). No fixed count — labels are kept
    // as long as there's enough room between them to stay readable; a
    // tight jagged cluster collapses down to its single most extreme
    // point since closely-spaced candidates fall inside the spacing zone.
    const standouts = findStandoutPoints(coords, avg, plotW * 0.09);
    for (const c of standouts) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const isPeak = avg !== null && c.value > avg;
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

    // Speedtests take 10-30s; poll status until it updates.
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
