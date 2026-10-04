// Source Health row for the Follow the Money tab: reports the state of the local ICIJ Offshore Leaks index
// and the full OFAC SDN screening index. No network — the indexes are built/refreshed by lib/finance, this
// just tells the Sources tab what is reporting and why not.
import { existsSync, statSync } from 'fs';
import { DEFAULT_INDEX, SNAPSHOT_INDEX, SNAPSHOT_GZ } from '../../lib/finance/sources/offshoreleaks.mjs';
import { DEFAULT_FILE as OFAC_FILE } from '../../lib/finance/sources/ofac.mjs';

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
