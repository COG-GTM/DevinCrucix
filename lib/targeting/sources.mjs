// Source context for a develop() run: everything CRUCIX already holds on disk or in memory, read-only.
// No network — development runs against what the sweeps have collected. Missing stores are reported as
// unavailable in the package's coverage block rather than fetched ad hoc.
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCorpus } from '../cjng/corpus.mjs';
import { loadReleases } from '../../apis/sources/doj.mjs';
import { DEFAULT_DATA_DIR as BORDER_DIR } from '../../apis/sources/bordernews.mjs';
import { loadIndex as loadOfacIndex } from '../../apis/sources/ofacnarco.mjs';

export const LOOKBACK_DAYS = 365;

function readJson(file, dflt) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; }
}

/**
 * @param live { graph, narcoData, telegramFeed }  in-memory server state
 */
export function buildSourceContext(live = {}, { now = Date.now(), lookbackDays = LOOKBACK_DAYS } = {}) {
  const cut = now - lookbackDays * 86_400_000;
  const border = readJson(join(BORDER_DIR, 'articles.json'), null);
  const articles = Array.isArray(border)
    ? border.filter(a => { const t = Date.parse(a.publishedAt || a.collectedAt); return Number.isFinite(t) && t >= cut; })
    : null;
  let dojReleases = null;
  try { dojReleases = loadReleases({ days: lookbackDays, now }); } catch { dojReleases = null; }
  const tg = live.telegramFeed;
  return {
    graph: live.graph || null,
    corpus: loadCorpus(),
    articles,
    dojReleases,
    ofacIndex: loadOfacIndex(),
    telegram: tg && Array.isArray(tg.messages) ? tg.messages : null,
    narcoClusters: live.narcoData && Array.isArray(live.narcoData.clusters) ? live.narcoData.clusters : null,
  };
}
