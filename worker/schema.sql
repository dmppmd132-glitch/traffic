-- 公車站站時刻表快取
-- 第一次查詢時由 Worker 從 TDX 匯入，之後 24 小時內優先使用 D1。
CREATE TABLE IF NOT EXISTS bus_schedule_cache (
  cache_key TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  route TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bus_schedule_updated
  ON bus_schedule_cache(updated_at);
