# Changelog

All notable changes to this repository are documented in this file. Entries are
grouped by week and reference the pull request that merged each change.

## Week of 2026-09-11 to 2026-09-18

### Features

- Add Target Development workbench: bounded public-source find/fix cycle with model-adjudicated correlation, gazetteer-snapped location records, pattern-of-activity, and sourced dossier export under `lib/targeting/` and `/api/targeting/*` ([#49](https://github.com/COG-GTM/DevinCrucix/pull/49))
- Add standing intelligence requirements (PIRs): plain-language rules compiled to a validated metric/threshold spec and evaluated every sweep against persistent 24 h–90 d baselines in `lib/requirements/` ([#47](https://github.com/COG-GTM/DevinCrucix/pull/47))
- Add CJNG knowledge graph on Cartels & Border: InSight Crime corpus read into a source-attributed entity/relation graph (D3 force layout, `GET /api/narco/graph`) ([#43](https://github.com/COG-GTM/DevinCrucix/pull/43))
- Add Frontlines strike-candidates layer and panel: FIRMS detections filtered and tiered by proximity to the DeepStateMAP contact line (`lib/firmsstrikes.mjs`) ([#44](https://github.com/COG-GTM/DevinCrucix/pull/44))
- Add dedicated Ukraine War theater tab: DeepStateMAP front map, front change log, air/EW, thermal, nuclear, and wires panels from `lib/ukraineview.mjs` ([#38](https://github.com/COG-GTM/DevinCrucix/pull/38))
- Add China / Taiwan tab with five key-free sources: Taiwan MND PLA activity, CGA grey-zone incidents, GCA events, filtered CNA/Taipei Times headlines, and a Polymarket allow-list ([#35](https://github.com/COG-GTM/DevinCrucix/pull/35))
- Add Iran War Live section: `iranwarlive` adapter, theater map tab, `iran-kinetic`/`iran-ground` map layers, and `GET /api/iranwar[/geo]` ([#32](https://github.com/COG-GTM/DevinCrucix/pull/32))
- Add operator-initiated photo geolocation on Investigations (model assessment, gazetteer-snapped, uncertainty circle) and colonia-level locality with verbatim evidence on Narco events ([#30](https://github.com/COG-GTM/DevinCrucix/pull/30))

### Bug Fixes

- Fix false "OFFLINE — LIVE FEED UNREACHABLE" banner on SSE drops: `/events` heartbeat (`SSE_HEARTBEAT_MS`), RECONNECTING state, half-open watchdog, and de-duplicated `/api/data` retry loop ([#36](https://github.com/COG-GTM/DevinCrucix/pull/36))

### Improvements

- Fold the Regional tab into Cartels & Border under grouped panel bands; `#regional` redirects via `TAB_ALIASES` ([#37](https://github.com/COG-GTM/DevinCrucix/pull/37))
- Consolidate CBP Public Data Portal into a Border / CBP panel group with new `CBPSeizures`, `CBPForce`, and `CBPCustody` adapters on shared `cbpcommon.mjs` ([#33](https://github.com/COG-GTM/DevinCrucix/pull/33))
- Show Air Activity and Carrier Groups layers by default (`pinned` layers) and draw individual aircraft markers from OpenSky tracks ([#29](https://github.com/COG-GTM/DevinCrucix/pull/29))

### Breaking Changes

- None (the Regional tab was retired in #37, but its `#regional` hash redirects to Cartels & Border)
