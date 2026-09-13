---
name: crucix-browser-testing
description: Run real-data CRUCIX dashboard tab and map checks locally, including SSE-aware browser instrumentation and honest source availability.
---

# Local dashboard browser testing

- Run `npm install --no-audit --no-fund`, then `PORT=3117 node server.mjs`. Restart any server using the chosen port after dashboard template changes. Stop an identified PID rather than a broad chained `pkill -f` command that can kill its own shell.
- No `CRUCIX_PASSWORD` is needed for unauthenticated local testing. Do not remove a configured password on a shared deployment.
- Startup can serve cached `runs/latest.json` before the initial sweep finishes. Wait for the server's sweep-complete log when testing current source-health states. Source failure/NO KEY/offline is distinct from a zero reading.
- The dashboard has a persistent SSE connection. In Playwright use `wait_until='load'` and then a relevant map/panel locator, not `networkidle`.
- Use the existing headed Chrome CDP endpoint when available. Identify the desired page by URL rather than assuming the last browser page is active; multiple dashboard windows may exist.
- Capture console errors with the page URL and console location, and pageerror stacks. Keep dashboard errors separate from external publisher-site errors and expected aborted SSE connections during reloads.
- For new-tab links, inspect the actual DOM anchor's `getAttribute('target')`, `outerHTML`, href and rel, then click with `context.expect_page()`. If computer-tool navigation appears to remove `_blank`, isolate the test using native Playwright clicks without intervening DOM-processing tools before reporting a product bug.
- Maps have scroll-to-zoom and drag-to-pan. Capture an intermediate held-drag screenshot and compare SVG `__zoom` before/after; allow reset/recenter animation to finish before reading its final transform.
- Tab navigation scrolls the window, and panel outline highlights are transient. Capture a screenshot promptly after headline clicks (~350 ms) to prove the outline. Read visible pixels, not just DOM presence.
- Narrow layouts intentionally collapse rails. Check map/chip bounds against viewport width and scroll to inspect lower panels.

## Devin Secrets Needed

- None for local read-only dashboard and unavailable-source behavior.
- `FIRMS_MAP_KEY` is required only to test live NASA FIRMS detections; without it verify NO KEY and no fabricated counts.
- Other keyed feeds and sidecars should be tested only when explicitly configured; don't synthesize live source data to claim coverage.
