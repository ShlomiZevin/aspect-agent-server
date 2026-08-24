/**
 * Coverage service — data-through + partial-last-day detection (Stage 2, Step 3).
 *
 * Generic: works for any dataset whose capability manifest declares a
 * `coverage` block ({dailyView, dateColumn, volumeColumn}). One cheap query
 * against the daily materialized view answers two questions every
 * latest-data answer must carry:
 *
 *   - dataThrough: the last date the feed actually holds
 *   - partialLastDay: is that final day materially below its own recent
 *     same-weekday volume? (The 2026-08-17 incident: the client's file was
 *     cut mid-day at 27% of normal lines, the system presented it as a
 *     complete Monday, and a store-total dispute followed. Detection is a
 *     trailing same-weekday median comparison — milliseconds, no LLM.)
 *
 * Cached for 5 minutes per dataset — a chat burst asks this dozens of times
 * against data that changes at most daily.
 */

const PARTIAL_THRESHOLD = 0.6;   // below 60% of the same-weekday median ⇒ partial
const CACHE_TTL_MS = 5 * 60 * 1000;
const TRAILING_DAYS = 28;        // window for the same-weekday median (4 samples)

const cache = new Map(); // datasetId -> { at, value }

/**
 * @param {Object} pool     - pg pool for the dataset's data DB
 * @param {Object} manifest - capability manifest with a `coverage` block
 * @returns {Promise<{dataThrough: string, partialLastDay: null|{date, volume, medianVolume, pctOfNormal}}|null>}
 *          null when the manifest has no coverage block or the check fails
 *          (coverage is an annotation, never a blocker).
 */
async function get(pool, manifest) {
  if (!manifest?.coverage) return null;
  const hit = cache.get(manifest.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const { dailyView, dateColumn, volumeColumn } = manifest.coverage;
  try {
    const { rows } = await pool.query(`
      WITH daily AS (
        SELECT ${dateColumn} AS d, SUM(${volumeColumn})::numeric AS vol
        FROM ${dailyView}
        WHERE ${dateColumn} >= (SELECT MAX(${dateColumn}) FROM ${dailyView}) - INTERVAL '${TRAILING_DAYS} days'
        GROUP BY 1
      ),
      last_day AS (SELECT d, vol FROM daily ORDER BY d DESC LIMIT 1),
      same_weekday AS (
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY daily.vol) AS median_vol
        FROM daily, last_day
        WHERE EXTRACT(DOW FROM daily.d) = EXTRACT(DOW FROM last_day.d)
          AND daily.d < last_day.d
      )
      SELECT to_char(l.d, 'YYYY-MM-DD') AS data_through, l.vol, s.median_vol
      FROM last_day l, same_weekday s`);

    if (!rows.length) return null;
    const { data_through, vol, median_vol } = rows[0];
    const value = { dataThrough: data_through, partialLastDay: null };
    if (median_vol != null && Number(median_vol) > 0) {
      const pct = Number(vol) / Number(median_vol);
      if (pct < PARTIAL_THRESHOLD) {
        value.partialLastDay = {
          date: data_through,
          volume: Number(vol),
          medianVolume: Math.round(Number(median_vol)),
          pctOfNormal: Math.round(pct * 100),
        };
      }
    }
    cache.set(manifest.id, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`⚠️  Coverage check failed for ${manifest.id}: ${err.message}`);
    return null;
  }
}

/** Test hook. */
function _clearCache() { cache.clear(); }

module.exports = { get, _clearCache, PARTIAL_THRESHOLD };
