// Source Health row for the Follow the Money tab: reports the state of the local ICIJ Offshore Leaks index
// and the full OFAC SDN screening index. No network — the indexes are built/refreshed by lib/finance, this
// just tells the Sources tab what is reporting and why not.
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_INDEX as DEFAULT_FULL, SNAPSHOT_INDEX, SNAPSHOT_GZ } from '../../lib/finance/sources/offshoreleaks.mjs';
import { DEFAULT_FILE as DEFAULT_OFAC } from '../../lib/finance/sources/ofac.mjs';

// Same overrides server.mjs hands to FinanceService, so a custom index location reports correctly.
const DEFAULT_INDEX = process.env.FINANCE_INDEX_FILE || DEFAULT_FULL;
const OFAC_FILE = process.env.FINANCE_DATA_DIR ? join(process.env.FINANCE_DATA_DIR, 'ofac-sdn.json') : DEFAULT_OFAC;

export async function briefing() {
  const full = existsSync(DEFAULT_INDEX), snap = existsSync(SNAPSHOT_INDEX) || existsSync(SNAPSHOT_GZ), ofac = existsSync(OFAC_FILE);
  const status = full ? 'ok' : snap ? 'fallback' : 'unavailable';
  return {
    source: 'OffshoreLeaks', timestamp: new Date().toISOString(), status,
    message: full ? `full ICIJ index (${(statSync(DEFAULT_INDEX).size / 1e6).toFixed(0)} MB)` : snap ? 'demo snapshot only — full index not built (set FINANCE_BUILD_ON_BOOT=1 or run scripts/build-offshoreleaks.mjs --download)' : 'no Offshore Leaks index',
    index: full ? 'full' : snap ? 'snapshot' : null,
    ofacSdnIndex: ofac,
    license: 'ICIJ Offshore Leaks Database, ODbL; OFAC SDN, public domain',
  };
}
