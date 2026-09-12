---
name: crucix-browser-testing
description: Run CRUCIX browser integration tests with live feeds, source-health checks, map persistence, and real SSE updates.
---

# CRUCIX browser integration testing

## Devin Secrets Needed
- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`

## Setup
- Use Node 22+, install dependencies with `npm install` if absent.
- Prefer reusing a healthy server at `http://localhost:3117/`. If none is running, start `node server.mjs` in a persistent tty shell from the repo root, or use the user-supplied credential-safe startup script if provided. Never print that script or its secret file contents.
- A handoff may select a different port/worktree. Prefer that explicit target over defaults; verify the listener's `/proc/<pid>/cwd` and compare its start time with the target revision before testing. Do not restart a healthy credential-configured server merely to switch from the usual checkout.
- If an inherited OpenSky credential shadows a freshly bound secret, bind org secrets under alternate names (`OSK_ID`, `OSK_SECRET`), then export `OPENSKY_CLIENT_ID="$OSK_ID" OPENSKY_CLIENT_SECRET="$OSK_SECRET"` before starting Node. Never print secrets.
- Avoid repeated starts or forced full sweeps: OpenSky has a daily credit budget. Reuse one server. Initial data may be cached; verify the fresh sweep timestamp, not merely dashboard visibility.
- A reported restart may have failed while an older listener remains healthy. Check the startup log for port conflicts and compare listener PID/start time with health uptime and the expected revision. If `lsof` is unavailable, `ss -ltnp 'sport = :3117'` can identify the listener. Only after restart authorization, stop the identified stale Node PID and run the credential-safe script with `setsid nohup`; verify the new post-sweep computation before recording. Never indiscriminately kill all Node processes.
- Current auth gate uses `CRUCIX_PASSWORD`; without a configured gate, no login is required. Do not unset an existing password gate merely for testing.

## Browser checks
- Tabs currently include Situation, Military, Cyber, Macro, Regional, Cartels, Investigations, Sources. The main shared map is on Situation; Cartels has a dedicated Mexico map.
- Read `/api/data`, `/api/seismic`, and `/api/health` from the browser for supporting evidence. Check live OpenSky OAuth status, region coverage, and realistic aggregate theater counts.
- Inspect both the source-health summary and individual panels: zero values may mean no data rather than quiet conditions. Distinguish live from degraded/reporting.
- Layer selection is stored in `crucix_layers_v1`; `RESET TO AUTO` removes the manual override. Test reload persistence, globe/flat transitions, and resizing while flat mode is active.
- Regional's Ukraine Front action enables Frontlines and focuses Situation. Historic nuclear test sites share the Seismic layer.
- Investigations accepts `example.com`, `8.8.8.8`, and rejects invalid selectors. Provider availability is not proof that a particular request succeeded; inspect actual timeout/error behavior.
- Cross-check the current raw dossier against the risk warning, Host Network field and Pivot Providers row. A healthy IP should clear the previous dossier's degraded indicator. Public DNS IPs from different registries can naturally exercise RDAP timeouts; do not assume a particular IP will always fail or mock failures as live evidence.
- Cartels has CURRENT MAP, 2020 BASELINE and COMPARE presets. Verify current crowd-sourced geometry versus historical amber overlays, toggle chips, and click near map edges to check popup bounds and the close control. Dedicated selection is stored in `crucix_ct_layers`.
- Regional includes Border Watch articles and Border Ingest. If the ingestion sidecar is unavailable, verify an explicit OFFLINE reason; report the populated path untested rather than fabricating data.
- Regional may also include CBP Enforcement Stats. Compare its named reporting month, encounters and drug-weight totals to `api/data.cbpStats`, not today's date; monthly source data is not a live incident count. Source Health reporting includes both live and degraded sources.
- If stale duplicate browser tabs cause loading/CDP trouble, close the duplicate tabs and reload before restarting a healthy backend.
- Use benign HTML-like input to test rejection, but do not claim hostile upstream-response escaping was verified from benign real data.

## Real update testing
- SSE endpoint is `/events`, not `/api/stream`.
- Default market refresh is 60 seconds, seismic refresh is 5 minutes, and full sweep is 15 minutes.
- A read-only extra EventSource listener can timestamp actual `market_update` and `update` messages while UI layer toggles are performed. Close that listener afterward.
- A seismic refresh also emits full-data `update`; distinguish that from a new full sweep using `/api/health.lastSweep`. Avoid an extra costly sweep solely for the race test unless approved.

## Visual evidence
- Maximize the browser before recording; when testing resize, restore maximized afterward.
- Browser-console read-only geometry inspection can support screenshots of map height and horizontal overflow.
- Report nonfatal Three.js/GSAP warnings separately from uncaught application errors.
- For aircraft tests, compare against the current sweep's bounded hotspot `tracks[]`, not a previously noted ICAO24: scheduled sweeps can replace the sample during recording. Aggregate aircraft counts can legitimately exceed the number of individual markers.
- Globe auto-rotation makes tiny point selection difficult. The native VISUALS LITE control can stabilize the view; restore the prior setting afterward and disclose this test control. Let region/zoom animations finish, zoom closer, and click the visible cylinder body rather than relying solely on a projected endpoint. Read-only geometry is supporting evidence, not a substitute for native clicks.
- Check map overlay hit-testing as well as rendering: flat corridor paths can overlap aircraft. A visible marker is not proven interactive until a native click opens its matching popup.

## Homeland / Narco
- Narco computation follows the full sweep. Compare `/api/narco` and `/api/data.narco` with the displayed Cartels view; a healthy server alone does not prove event readiness.
- Establish baseline totals from the actual sweep, not hardcoded fixture expectations: cluster/current/historical counts, grade distribution and finite-coordinate events. Several pins can overlap at district-centroid coordinates.
- The Graded Events panel sits below the dedicated Cartels map; DOJ and OFAC panels follow it. Grade and event-type chips affect both timeline and pins. Timeline historical inclusion and map historical-layer toggles are separate controls.
- `EVENTS` preset can isolate new circles when old influence geometry is toggled off. Fill encodes event family and ring encodes confidence. An unlocated historical event cannot demonstrate dashed historical pins; report that branch untested.
- Follow a real official source and exercise browser Back as well as explicit reload. If restored UI is pending/empty while APIs are live, preserve both states and check cache/startup behavior; do not inject data into the page to make the flow pass.
- Validate unknown query parameters as well as malformed known values on narco endpoints. The sanctions endpoint requires a real `name` query.
- Confirm the revision's unknown-key contract per route: Narco may reject unknown keys while release-line `validateQuery` routes intentionally ignore extras and consume only `req.validated.query`. Do not assume these conventions are identical after a merge.
- Separate normalized event quality from source-panel coverage: pesticide/export-control news may legitimately remain in the DOJ list, but should not become cartel-crime events. Check fees, transfers and loss amounts are not interpreted as seized cash; small drug amounts must not display as zero.
- For quantity quality checks, distinguish drug valuations from seized cash and administration-wide totals from the individual incident's seizure. Same-sentence seizure wording alone does not establish event scope. Compare event location with the actual incident rather than a cartel's home region mentioned in a contextual article.
- If a publisher blocks the browser, the runtime's collected source text may be available in `runs/border/articles.json` (`text`, `collectedAt`, `extraction`) and its referenced raw snapshot under `runs/border/raw/`. Use this as explicitly labeled cached-source evidence; do not claim that the publisher page was accessible or current.
- When a single-incident popup contains implausible casualty/seizure/group combinations, compare the article body with Popular/Related-story sidebars. Generic `page:paragraphs` extraction can include those unrelated stories; duplicate quantities and shared eight-dead/300-kg figures across different reports are useful warning signs. Preserve the event ID, publisher URL, extraction method and popup/source screenshots; distinguish source-scope contamination from clustering errors.
- Browser Find can bring an expanded event detail back into view when rerendering resets the internally scrolling timeline. Report this scroll reset separately if it affects usability.
- Show on map animates the viewport. Let the pan complete before clicking the centered pin; otherwise the click may select an unrelated old position. Use the EVENTS preset and layer controls to reduce unrelated markers when they overlap event circles. Overlapping event pins can still expose only the uppermost popup; use timeline detail to distinguish coincident incidents.
- When sharing the desktop with another agent, coordinate Chrome ownership and verify the origin after unexpected tabs appear. A second server may auto-open its own dashboard; do not attribute that instance to the target revision.

## Investigations image geolocation
- Navigate Investigations → Toolkit → Media forensics and use the native file picker. Generate a small JPEG without EXIF and another with known GPS using existing Pillow `Image.Exif`; retain expected hashes/dimensions and coordinates for comparison.
- For intentionally unconfigured model tests, verify `llmEnabled:false` and provider absence without printing secret values. Do not configure a model merely to bypass the unavailable branch. No-GPS should expose unavailable/no-model, while EXIF GPS suppresses the model card.
- The upload boundary is 12 MiB (12*1024*1024 bytes), despite the UI's MB label. A valid JPEG padded to exactly that size exercises acceptance; one extra byte exercises both client rejection and server raw-body parser rejection.
- Investigations routes share an IP-based rate bucket. Do upload UI checks before bounded rate-limit probing; previous requests count against the bucket. Confirm both metadata/geolocate return 429 and later recover naturally before repeating uploads.
- When explicitly authorized, test the session-only `ctAssessments` renderer separately from real inference. Label the entry synthetic; use a literal HTML-tag clue, native circle/pin clicks and the popup's unpin link. Confirm the array and `.ct-assess`/`.ct-assess-c` nodes are removed. This proves rendering/escaping, not model accuracy.
