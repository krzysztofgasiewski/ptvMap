require("dotenv").config();
const express = require("express");
const compression = require("compression");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const ZTM_URL =
  "https://dane.um.warszawa.pl/api/action/get_ztm_lokalizacja_pojazdow";
const CACHE_TTL = 8000;
const STALE_MS = 5 * 60 * 1000;
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// ---------- Logger ----------
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const ACTIVE_LEVEL = LEVELS[LOG_LEVEL] || LEVELS.info;

const COLORS = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const useColor = process.stdout.isTTY;
const c = (color, text) =>
  useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function fmt(level, scope, msg, meta) {
  if (LEVELS[level] < ACTIVE_LEVEL) return;
  const tag = level.toUpperCase().padEnd(5);
  const scopeStr = c("dim", `[${scope}]`).padEnd(useColor ? 22 : 14);
  const head = `${c("dim", ts())} ${c(level, tag)} ${scopeStr} ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    const metaStr = Object.entries(meta)
      .map(
        ([k, v]) =>
          `${c("dim", k + "=")}${typeof v === "string" ? v : JSON.stringify(v)}`,
      )
      .join(" ");
    console.log(`${head} ${c("dim", "·")} ${metaStr}`);
  } else {
    console.log(head);
  }
}

const log = {
  trace: (scope, msg, meta) => fmt("trace", scope, msg, meta),
  debug: (scope, msg, meta) => fmt("debug", scope, msg, meta),
  info: (scope, msg, meta) => fmt("info", scope, msg, meta),
  warn: (scope, msg, meta) => fmt("warn", scope, msg, meta),
  error: (scope, msg, meta) => fmt("error", scope, msg, meta),
};

// ---------- Boot ----------
log.info("boot", "starting server", {
  port: PORT,
  node: process.version,
  env: process.env.NODE_ENV || "development",
});
log.info("boot", "logging configured", { level: LOG_LEVEL });

if (!API_KEY) {
  log.error(
    "boot",
    "API_KEY missing from environment — upstream calls will fail",
  );
} else {
  log.info("boot", "API key loaded", {
    length: API_KEY.length,
    fingerprint: crypto
      .createHash("sha256")
      .update(API_KEY)
      .digest("hex")
      .slice(0, 8),
  });
}

log.info("boot", "cache configured", {
  ttl_ms: CACHE_TTL,
  stale_threshold_ms: STALE_MS,
});

// ---------- Middleware ----------
app.use(compression());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.use((req, res, next) => {
  const reqId = crypto.randomBytes(3).toString("hex");
  req.reqId = reqId;
  req.startTs = process.hrtime.bigint();
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();

  log.debug("http", `→ ${req.method} ${req.url}`, {
    req: reqId,
    ip,
    ua: (req.headers["user-agent"] || "").slice(0, 60),
  });

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - req.startTs) / 1e6;
    const level =
      res.statusCode >= 500
        ? "error"
        : res.statusCode >= 400
          ? "warn"
          : "debug";
    fmt(level, "http", `← ${res.statusCode} ${req.method} ${req.url}`, {
      req: reqId,
      ms: ms.toFixed(1),
      bytes: res.getHeader("content-length") || "?",
    });
  });

  next();
});

// ---------- ZTM client ----------
const cache = { 1: { data: null, ts: 0 }, 2: { data: null, ts: 0 } };
const inflight = { 1: null, 2: null };
const stats = {
  upstream_ok: 0,
  upstream_fail: 0,
  cache_hits: 0,
  cache_miss: 0,
  dedup_hits: 0,
};

async function fetchZTM(type, reqId) {
  const t0 = process.hrtime.bigint();
  log.debug("ztm", "upstream request", { req: reqId, type });

  let response;
  try {
    response = await fetch(ZTM_URL, {
      method: "POST",
      headers: { Authorization: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
  } catch (err) {
    stats.upstream_fail++;
    log.error("ztm", "upstream network error", {
      req: reqId,
      type,
      error: err.message,
    });
    throw err;
  }

  const upstreamMs = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);

  if (!response.ok) {
    stats.upstream_fail++;
    log.warn("ztm", "upstream non-2xx", {
      req: reqId,
      type,
      status: response.status,
      ms: upstreamMs,
    });
    throw new Error(`Upstream ${response.status}`);
  }

  const data = await response.json();
  const raw = Array.isArray(data) ? data : data.result;
  if (!Array.isArray(raw)) {
    stats.upstream_fail++;
    log.error("ztm", "unexpected upstream payload shape", {
      req: reqId,
      type,
      payload_type: typeof data,
      keys:
        data && typeof data === "object"
          ? Object.keys(data).slice(0, 5).join(",")
          : "n/a",
    });
    throw new Error("Unexpected upstream shape");
  }

  const now = Date.now();
  let kept = 0,
    dropOutOfBounds = 0,
    dropStale = 0,
    dropInvalid = 0;
  const filtered = [];

  for (const v of raw) {
    if (
      typeof v.Lat !== "number" ||
      typeof v.Lon !== "number" ||
      v.Lat === 0 ||
      v.Lon === 0
    ) {
      dropInvalid++;
      continue;
    }
    if (v.Lat < 51.5 || v.Lat > 53 || v.Lon < 20 || v.Lon > 22) {
      dropOutOfBounds++;
      continue;
    }
    const t = new Date(v.Time.replace(" ", "T")).getTime();
    if (isNaN(t) || now - t > STALE_MS) {
      dropStale++;
      continue;
    }
    filtered.push({
      i: v.VehicleNumber,
      l: v.Lines,
      b: v.Brigade,
      la: v.Lat,
      lo: v.Lon,
      t: v.Time,
    });
    kept++;
  }

  stats.upstream_ok++;
  log.info("ztm", "upstream fetched and filtered", {
    req: reqId,
    type,
    upstream_ms: upstreamMs,
    received: raw.length,
    kept,
    dropped_stale: dropStale,
    dropped_oob: dropOutOfBounds,
    dropped_invalid: dropInvalid,
  });

  return filtered;
}

// ---------- Routes ----------
app.get("/api/vehicles", async (req, res) => {
  const type = req.query.type === "2" ? 2 : 1;
  const now = Date.now();
  const reqId = req.reqId;

  if (cache[type].data && now - cache[type].ts < CACHE_TTL) {
    stats.cache_hits++;
    const age = now - cache[type].ts;
    log.debug("cache", "hit", {
      req: reqId,
      type,
      age_ms: age,
      ttl_remaining_ms: CACHE_TTL - age,
      vehicles: cache[type].data.length,
    });
    return res.json({ result: cache[type].data, cached: true });
  }

  stats.cache_miss++;

  if (inflight[type]) {
    stats.dedup_hits++;
    log.debug("cache", "miss — joining in-flight upstream", {
      req: reqId,
      type,
    });
  } else {
    log.debug("cache", "miss — initiating upstream", { req: reqId, type });
    inflight[type] = fetchZTM(type, reqId)
      .then((data) => {
        cache[type] = { data, ts: Date.now() };
        log.debug("cache", "updated", { type, vehicles: data.length });
        return data;
      })
      .finally(() => {
        inflight[type] = null;
      });
  }

  try {
    const data = await inflight[type];
    res.json({ result: data, cached: false });
  } catch (err) {
    if (cache[type].data) {
      const age = now - cache[type].ts;
      log.warn("cache", "serving stale cache after upstream failure", {
        req: reqId,
        type,
        age_ms: age,
        vehicles: cache[type].data.length,
      });
      return res.json({ result: cache[type].data, cached: true, stale: true });
    }
    log.error("api", "no cache available, returning 500", {
      req: reqId,
      type,
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime_s: Math.round(uptime),
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    stats,
    cache: {
      1: cache[1].data
        ? { vehicles: cache[1].data.length, age_ms: Date.now() - cache[1].ts }
        : null,
      2: cache[2].data
        ? { vehicles: cache[2].data.length, age_ms: Date.now() - cache[2].ts }
        : null,
    },
  });
});

// ---------- Periodic stats heartbeat ----------
setInterval(() => {
  const mem = process.memoryUsage();
  log.info("stats", "heartbeat", {
    upstream_ok: stats.upstream_ok,
    upstream_fail: stats.upstream_fail,
    cache_hits: stats.cache_hits,
    cache_miss: stats.cache_miss,
    dedup_hits: stats.dedup_hits,
    rss_mb: (mem.rss / 1024 / 1024).toFixed(1),
    heap_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
  });
}, 60000);

// ---------- Error handlers ----------
app.use((err, req, res, next) => {
  log.error("http", "unhandled error", {
    req: req.reqId,
    error: err.message,
    stack: err.stack?.split("\n")[1]?.trim(),
  });
  res.status(500).json({ error: "internal" });
});

process.on("uncaughtException", (err) => {
  log.error("process", "uncaught exception", {
    error: err.message,
    stack: err.stack?.split("\n").slice(0, 3).join(" | "),
  });
});

process.on("unhandledRejection", (reason) => {
  log.error("process", "unhandled rejection", {
    reason: String(reason).slice(0, 200),
  });
});

process.on("SIGTERM", () => {
  log.info("process", "SIGTERM received, shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("process", "SIGINT received, shutting down");
  process.exit(0);
});

// ---------- Start ----------
app.listen(PORT, () => {
  log.info(
    "boot",
    `${c("bold", "ready")} — listening on http://localhost:${PORT}`,
  );
});
