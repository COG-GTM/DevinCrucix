<div align="center">

# Crucix

**Your own intelligence terminal. 27 sources. One command. Zero cloud.**

## [Visit The Live Site: crucix.live](https://www.crucix.live/)

[![Live Website](https://img.shields.io/badge/live-crucix.live-00d4ff?style=for-the-badge)](https://www.crucix.live/)
[![Open Demo](https://img.shields.io/badge/open-live%20dashboard-0b1220?style=for-the-badge&logo=googlechrome&logoColor=white)](https://www.crucix.live/)

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](#quick-start)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-1%20(express)-orange)](#architecture)
[![Sources](https://img.shields.io/badge/OSINT%20sources-27-cyan)](#data-sources-27)
[![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)](#docker)

**Enter The Signal Network**

[![Signal Wire](https://img.shields.io/badge/Signal%20Wire-%40crucixmonitor-111111?style=for-the-badge&logo=x&logoColor=white)](https://x.com/crucixmonitor)
[![Ops Room](https://img.shields.io/badge/Ops%20Room-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/ChVy7SF4)

![Crucix Dashboard](docs/dashboard.png)

<details>
<summary>More screenshots</summary>

| Boot Sequence | World Map |
|:---:|:---:|
| ![Boot](docs/boot.png) | ![Map](docs/map.png) |

| 3D Globe View |
|:---:|
| ![Globe](docs/globe.png) |

</details>

</div>

> **Live website:** [https://www.crucix.live/](https://www.crucix.live/)
> Explore the public demo first, then clone the repo to run Crucix locally.

Crucix pulls satellite fire detection, flight tracking, radiation monitoring, satellite constellation tracking, economic indicators, live market prices, conflict data, sanctions lists, and social sentiment from 27 open-source intelligence feeds — in parallel, every 15 minutes — and renders everything on a single self-contained Jarvis-style dashboard.

Hook it up to an LLM and it becomes a **two-way intelligence assistant** — pushing multi-tier alerts to Telegram and Discord when something meaningful changes, responding to commands like `/brief` and `/sweep` from your phone, and generating actionable trade ideas grounded in real cross-domain data. Your own analyst that watches the world while you sleep.

Try the live demo first at [https://www.crucix.live/](https://www.crucix.live/), then clone the repo when you want the full local stack.

No cloud. No telemetry. No subscriptions. Just `node server.mjs` and you're running.

## Token / Asset Warning

> [!WARNING]
> **Crucix has not launched any official token, coin, NFT, airdrop, presale, or other blockchain-based asset.**
> Any token or digital asset using the Crucix name, logo, or branding is not affiliated with or endorsed by Crucix.
> Do not buy it, promote it, connect a wallet to claim it, sign transactions, or send funds based on third-party posts, DMs, or websites.

---

## Why This Exists

Most of the world's real-time intelligence — satellite imagery, radiation levels, conflict events, economic indicators, flight tracking, maritime activity — is publicly available. It's just scattered across dozens of government APIs, research institutions, and open data feeds that nobody has time to check individually.

Crucix brings it all into one place. Not behind a paywall, not locked in an enterprise platform, not requiring a security clearance. Just open data, aggregated and cross-correlated on your own machine, updated every 15 minutes.

It was built for anyone who wants to understand what's actually happening in the world right now — researchers, journalists, traders, OSINT analysts, or just curious people who believe access to information shouldn't depend on your budget.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/calesthio/Crucix.git
cd Crucix

# 2. Install dependencies (just Express)
npm install

# 3. Copy env template and add your API keys (see below)
cp .env.example .env

# 4. Start the dashboard
npm run dev
```

> **If `npm run dev` fails silently** (exits with no output), run Node directly instead:
> ```bash
> node --trace-warnings server.mjs
> ```
> This bypasses npm's script runner, which can swallow errors on some systems (particularly PowerShell on Windows). You can also run `node diag.mjs` to diagnose the exact issue — it checks your Node version, tests each module import individually, and verifies port availability. See [Troubleshooting](#troubleshooting) for more.

The dashboard opens automatically at `http://localhost:3117` and immediately begins its first intelligence sweep. This initial sweep queries all 27 sources in parallel and typically takes 30–60 seconds — the dashboard will appear empty until the sweep completes and pushes the first data update. After that, it auto-refreshes every 15 minutes via SSE (Server-Sent Events). No manual page refresh needed.

**Requirements:** Node.js 22+ (uses native `fetch`, top-level `await`, ESM)

### Docker

```bash
git clone https://github.com/calesthio/Crucix.git
cd Crucix
cp .env.example .env    # add your API keys
docker compose up -d
```

Dashboard at `http://localhost:3117`. Sweep data persists in `./runs/` via volume mount. Includes a health check endpoint.

Compose starts two services: the Node dashboard (`crucix`) and the Python Border Watch ingestion service (`ingest`, see below). The ingestion API is only reachable from the dashboard container; it is not published to the host.

### Fly.io (shared URL with password gate)

```bash
fly launch --copy-config --no-deploy     # first time only; creates the app from fly.toml
fly secrets set CRUCIX_PASSWORD='your-access-code' CRUCIX_SESSION_SECRET=$(openssl rand -hex 32)
fly deploy
```

Setting `CRUCIX_PASSWORD` puts a login page in front of the dashboard and all `/api/*` routes (except `/api/health`). Failed attempts are rate-limited (5 per IP, 15-minute lockout). Leave it unset for local use. Anyone without the access code sees only the login page, so a deployment can stay private to whoever holds the code.

### Investigations tab & Typosquat Watch

The **Investigations** tab is a dedicated OSINT workbench: enter any selector — domain, URL, IPv4/IPv6, MD5/SHA-1/SHA-256 hash, email, `@handle`, `+phone`, BTC/ETH address, or company name — and CRUCIX fans out to every relevant passive source in parallel and renders a dossier with rule-based risk indicators. Every blue value pivots into a new dossier without losing context; pivots accumulate into a browser-local **case file** (entities, relationships, notes) with a force-directed **case graph**, a cross-source **timeline**, a **toolkit** of type-specific search dorks and external deep links, EXIF/GPS **metadata forensics** for uploaded images (parsed in memory, never written to disk), and Markdown / JSON / SVG **report export**. All lookups are read-only; `/api/investigate*` is rate-limited per IP and URL analysis refuses private, loopback and link-local destinations.

| Source | Key needed | Returns |
|--------|-----------|---------|
| RDAP WHOIS (`rdap.org`) | none | registrar, registrant, dates, nameservers, DNSSEC, IP allocation/org |
| DNS-over-HTTPS (Cloudflare) | none | A/AAAA/MX/NS/TXT, SPF, DMARC, reverse DNS |
| Certificate Transparency (`crt.sh`) | none | hostnames seen in certificates, recent issuers |
| Shodan InternetDB | none | open ports, CVEs, hostnames, tags per IP |
| ipwho.is · Tor exit list | none | geolocation, ASN, Tor exit-node status |
| Wayback Machine · AlienVault OTX · urlscan.io | none | archive history, threat pulses, public scans |
| HTTP fingerprint | none | status, server, title, redirect chain, phishing heuristics for URLs |
| Gravatar · Keybase · GitHub | none (`GITHUB_TOKEN` optional) | identity claims, avatar hash, public repos / commit-email leaks |
| Platform probes (API-verified) | none | handle presence on major platforms; generic 200s are never treated as a hit |
| mempool.space · BlockCypher · OFAC SDN | none | BTC/ETH balance, tx counts, counterparties, sanctions-list match |
| Look-alike probe | none | registered typosquat permutations of the target |
| VirusTotal | `VIRUSTOTAL_API_KEY` | AV verdicts, reputation, threat label for domain/IP/hash |
| Shodan | `SHODAN_API_KEY` | org, ASN, services/banners, full vuln list |
| Have I Been Pwned | `HIBP_API_KEY` | breach names, dates, exposed data classes per email |
| NumVerify | `NUMVERIFY_API_KEY` | carrier, line type, location for phone numbers |
| OpenCorporates | `OPENCORPORATES_API_TOKEN` | company matches, jurisdiction, status, address |
| OpenSanctions | `OPENSANCTIONS_API_KEY` | sanctions / PEP screening for wallets and entities |

Keyed sources are skipped (marked "no key" in the panel) when their variable is blank. Results are cached for 15 minutes.

**Typosquat Watch** runs in the sweep: for each domain in `TYPOSQUAT_WATCHLIST` (default: `treasury.gov,irs.gov,cisa.gov,defense.gov,login.gov`) it generates DNS-Twist-style permutations (homoglyph, omission, transposition, TLD swap, hyphenation, keyword addition, …), resolves them over DoH, and lists the registered ones, flagging any that are new since the previous sweep. Set the variable to an empty string to disable.

### Border Watch (US–Mexico border news)

Keyless, registry-driven regional news collection. Outlets live in `config/border-sources.json` with outlet, feed URL, feed type (`rss`, `atom` or `news-sitemap`), language, region, discovery date, and a reliability grade (`ungraded` until reviewed). Each sweep polls the feeds with `If-None-Match`/`If-Modified-Since` (a 304 is a healthy "unchanged" poll), normalizes items with a content hash, pipeline version, and provenance, then fetches a bounded number of article bodies per feed via the public WordPress REST API or the article page — after a robots.txt check, with the descriptive CRUCIX User-Agent, never bypassing paywalls (paywalled or blocked articles keep their feed-level record and are flagged). Rule-based bilingual (EN/ES) topic tags (violence, narcotics, enforcement, migration, rail, trade, governance) and a border-sector gazetteer (wire datelines are ignored for place tagging) feed a per-place/topic spike detector that stays silent until at least 3 days of baseline exist.

Registered outlets: Border Report, The Texas Tribune, ValleyCentral (Rio Grande Valley), Zeta Tijuana (ES), Borderland Beat (Atom; full text in feed so article pages are never fetched), Justice in Mexico, InSight Crime's Mexico tag, and Milenio (ES; Google News sitemap advertised in its robots.txt — no RSS exists; section-filtered and place-gated; article pages never fetched). Per-source policy fields:

- `feedType` — `rss` (default), `atom`, or `news-sitemap` (Google News `<urlset>` with `news:news` blocks).
- `fetchArticles: false` — never request article pages/APIs for this outlet (used when the publisher's terms restrict automated access beyond the feed, or when the feed already carries full text).
- `pathPrefixes` — keep only items whose URL path starts with one of these sections (e.g. Milenio `/policia`, `/estados`).
- `requirePlaceTag: true` — drop items that do not mention a border-sector place (keeps national outlets on-topic).
- `BORDER_FETCH_ARTICLES` (default `true`) — set `false` for headlines/descriptions only, globally.
- `BORDER_MAX_ARTICLE_FETCH` (default `5`, max `20`) — article bodies fetched per feed per sweep; the backlog drains on later sweeps.
- `GET /api/border/articles?place=el-paso-tx&topic=enforcement&outlet=borderreport&days=7&limit=50` — filters are whitelisted keys; anything else is a 400.

Panel states are reported per feed (`LIVE`, `UNCHANGED`, `EMPTY`, `BLOCKED`, `ERROR`) and per article (`PAYWALL`, `WIRE`, `FEED-ONLY`). Runtime state is kept under `runs/border/`.

### Cartels (Mexico)

The **CARTELS** tab is a Mexico-framed page that puts two deliberately separate layers side by side:

| Layer | Source | Era | Drawn as |
|-------|--------|-----|----------|
| Current influence areas, activity/crime pins, active wars, truces, alleged alliances, strongholds, alleged safehouses, government/military ops, activity in the U.S. | *Active Cartels In Mexico* Google My Maps KML (@MexicoCartelMap) — crowd-sourced, single maintainer | polled each sweep, 24 h cache | solid lines, maintainer's colour legend |
| Cartel density by state, CJNG footprint, trafficking flows, ports / points of entry, narcotics-concentration cities, avocado & huachicol hotspots, CJNG 2009–2019 timeline | START (University of Maryland) *Tracking Cartels* research briefs, transcribed by hand into `config/cartels-baseline-2020.json` | June 2020, static | amber, dashed, labelled `START June 2020` |

Neither layer is verified control of territory: the KML's own disclaimer says it is not 100% accurate and can go out of date quickly, and the START baseline is a point-in-time research product (two state classes were read visually from the printed choropleth and carry a note saying so). The Situation strip only ever emits an *info* pointer from the current layer, and only when the KML fetched live, is not a cached copy, and has dated entries within the last 7 days; the START data never generates alerts. A third panel lists Mexico / Northern Triangle items already collected by InSight Crime, Border Watch and GDELT (keyword filter — journalism, not event data).

Every KML string (names, descriptions, folder names, URLs, dates) is bounded and stripped of markup at ingestion and HTML-escaped again at render; only `http(s)` links survive. The trimmed summary is injected into the dashboard payload; polygon/point geometry (~400 KB) is served separately from `GET /api/cartels/geo` and fetched by the browser only when the tab is opened.

## Border Watch Ingestion (Python)

`ingest/` is a standalone Python 3.10+ service that continuously collects, cleans, deduplicates and entity-extracts border-region reporting from English- and Spanish-language outlets, loads government/research datasets as historical baselines, and flags anomalies (e.g. a spike in violence reporting in a border county relative to its own history). The Node dashboard reads its JSON API and renders the **Border Watch** panel.

```bash
cd ingest
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m spacy download xx_ent_wiki_sm   # multilingual NER model (optional; NER degrades gracefully without it)

python -m crucix_ingest sources           # source registry (data, not code: crucix_ingest/data/sources.seed.json)
python -m crucix_ingest poll              # one polling pass over every enabled source
python -m crucix_ingest baselines --list  # structured baseline loaders and their refresh schedules
python -m crucix_ingest serve             # scheduler (feeds every 15 min, baselines on their own schedules) + JSON API on 127.0.0.1:3118
```

Then start the dashboard as usual (`npm run dev`); it discovers the service through `INGEST_API_URL`. The Python service reads its configuration from environment variables only, so export the `INGEST_*` block from `.env` (`set -a; . ./.env; set +a`) or run everything via Docker Compose.

### Collection policy

- **Publisher-advertised endpoints only** — RSS/Atom, Google News sitemaps, and WordPress REST APIs (the Texas Tribune and InSight Crime are read through their APIs, not scraped).
- **robots.txt is enforced on every request**, including redirects and sitemap children; an unavailable robots policy fails closed.
- **Conditional requests** (`ETag` / `Last-Modified`), a per-host delay, bounded response sizes and a fixed, descriptive User-Agent (`CrucixBorderWatch/1.0 (+https://crucix.fly.dev/crawler; …)`).
- **No paywall bypass.** Paywalled items keep headline, feed summary, URL and timestamp only and are tagged `paywalled: true`. HTTP 401/403 are recorded as blocked and never retried with a different identity.
- **Terms of use are data.** Outlets whose terms prohibit crawling (Nexstar, Hearst, KRGV, Milenio) are registered with `content_policy: metadata_only` — only the advertised feed is read and article pages are never requested. Every entry in `sources.seed.json` records its terms URL, discovery method and the reason for its policy.
- **No stealth techniques** — no proxies, no rotating identities, no headless browsers.
- Spanish text is the record of truth; machine translation is a separate, labelled derived field, and NER runs on the original language.

### Baselines

Structured datasets are loaded on their own schedules and exposed under `/baselines`: SESNSP municipal crime incidence (monthly), CBP nationwide encounters and drug seizures by AOR (monthly), FRA rail equipment and grade-crossing incidents for border states (monthly), InSight Crime publications and criminal-group profiles (weekly), Justice in Mexico *Organized Crime and Violence in Mexico* releases (quarterly check), and an optional one-time ACLED snapshot from a manually downloaded export (`INGEST_ACLED_SNAPSHOT_PATH`). Anomalies are computed per region/series against each dataset's own history and persisted alongside the news-reporting anomalies.

### Ingestion API (`INGEST_API_URL`, default `http://127.0.0.1:3118`)

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status, degraded sources, last sweep, baseline status (always HTTP 200) |
| `GET /sources` | Source registry with polling state |
| `GET /articles?limit=&since=&region=&violence=1&language=&source=` | Cleaned article metadata, regions, entities and violence terms |
| `GET /articles/<id>` | Full record incl. original text and derived translation |
| `GET /anomalies?limit=&since=` | News and baseline anomalies |
| `GET /baselines`, `GET /baselines/<dataset>/records?series=&region=&limit=` | Baseline datasets and records |
| `GET /summary` | Dashboard summary |
| `POST /poll`, `POST /baselines/check` | Trigger a run — loopback clients only |

The dashboard proxies the read-only routes at `/api/ingest/*` (allow-list in `apis/sources/borderingest.mjs`) and serves the synthesized panel data at `/api/border`. Tests: `cd ingest && pytest` (recorded fixtures under `ingest/tests/fixtures/`), `ruff check .`, `mypy crucix_ingest`.

### CBP Enforcement Statistics (official CSVs)

`apis/sources/cbpstats.mjs` reads the monthly CSVs U.S. Customs and Border Protection publishes (public domain): *Nationwide Encounters by Area of Responsibility* and *Nationwide Drug Seizures*. Because the file name moves every month, each sweep first reads the official document pages (`/document/stats/nationwide-encounters`, `/document/stats/nationwide-drug-seizures`), picks the newest `.csv` link, and falls back to the last verified URL if the page is unreachable. Downloads are conditional (ETag / Last-Modified) and cached under `runs/cbp/`, so a CBP outage degrades the panel to `STALE` instead of blanking it; a changed header row is refused rather than guessed at. The panel shows Southwest-land-border encounters (total, USBP vs OFO, 13-month trend, per-sector MoM/YoY, demographic, top citizenships) and Southwest drug seizures (lbs and events by drug type and AOR). Fiscal-year months are converted to calendar months (FY starts 1 October). Note that cbp.gov's edge returns 403 to curl-style clients; the source relies on Node's native `fetch`.

---

## What You Get

### Live Dashboard
A self-contained Jarvis-style HUD with:
- **3D WebGL globe** (Globe.gl) with atmosphere glow, star field, and smooth rotation — plus a classic flat map toggle
- **Map layers** shared by both views (registry in `lib/maplayers.mjs`): air traffic, fire detections, radiation sites, maritime chokepoints, SDR receivers, OSINT events, health alerts, geolocated news, conflict events, carrier groups, GDELT clusters, narco reporting, space stations, PRC activity, GPS jamming, military ADS-B, market intel
- **Signal-first defaults** — each sweep the server marks every layer `signal` (something notable this sweep), `data` (has points, nothing notable) or `none` (nothing to plot, with the reason: needs key, source failed, quiet). The map starts with only the `signal` layers on (max 5, padded to 3 with `data` layers); the chip row under the map toggles any layer, remembers a manual selection in local storage, and `RESET TO AUTO` returns to the sweep's defaults. Globe and flat map always show the same selection
- **Panel captions** — every panel opens with one line saying what it shows, which source or computation feeds it, and what it does not establish (`Derived.` marks composites that add no independent data)
- **Animated 3D flight corridor arcs** between air traffic hotspots and global hubs
- **Region filters** (World, Americas, Europe, Middle East, Asia Pacific, Africa) — rotates the globe or zooms the flat map
- **Live market data** — indexes, crypto, energy, commodities via Yahoo Finance (no API key needed)
- **Risk gauges** — VIX, high-yield spread, supply chain pressure index
- **OSINT feed** — English-language posts from 17 Telegram intelligence channels (expandable)
- **News ticker** — merged RSS + GDELT headlines + Telegram posts, auto-scrolling
- **Sweep delta** — live panel showing what changed since last sweep (new signals, escalations, de-escalations with severity)
- **Cross-source signals** — correlated intelligence across satellite, economic, conflict, and social domains
- **Nuclear watch** — real-time radiation readings from Safecast + EPA RadNet
- **Space watch** — CelesTrak satellite tracking: recent launches, ISS, military constellations, Starlink/OneWeb counts
- **Leverageable ideas** — AI-generated trade ideas (with LLM) or signal-correlated ideas (without)

### Performance Modes
The `VISUALS FULL` / `VISUALS LITE` button in the top bar only changes rendering behavior - it does **not** remove data sources or reduce sweep coverage.

When you switch to **VISUALS LITE**, the dashboard:
- Disables decorative background effects such as the radial/grid overlays and scanlines
- Removes expensive blur/backdrop-filter effects on panels and overlays
- Stops non-essential animations like the logo ring blink, conflict rings, and corridor flow effects
- Disables globe auto-rotation and turns off animated flight-arc dashes
- Converts the horizontal news ticker and OSINT stream into static, scrollable lists instead of continuously animated marquees

Mobile-specific behavior:
- On mobile, `VISUALS LITE` also forces the dashboard into **flat map mode** if you are currently on the globe
- Future mobile loads will continue to start flat while low-perf mode is enabled

The preference is saved in browser local storage, so the UI will remember your last setting.

### Auto-Refresh
The server runs a sweep cycle every 15 minutes (configurable). Each cycle:
1. Queries all 27 sources in parallel (~30s)
2. Synthesizes raw data into dashboard format
3. Computes delta from previous run (what changed, escalated, de-escalated) — visible in the **What Changed** panel on the Situation tab
4. Builds the **Situation strip**: up to 5 rule-based headline judgments (`lib/situation.mjs` — DEFCON, delta, flash alerts, radiation, PRC tension, focal points, CII, convergence, Border Watch spikes, KEV surges, Kp storms, new look-alike domains, source coverage). No LLM involved; each card links to the tab/panel holding the evidence. The same pass ranks the **map layers** (`lib/maplayers.mjs`) so the globe opens on what has signal this sweep
5. Generates LLM trade ideas (if configured)
6. Evaluates breaking news alerts — multi-tier (FLASH / PRIORITY / ROUTINE) with semantic dedup. Sends to Telegram and/or Discord if configured. Works with LLM evaluation or falls back to rule-based alerting when LLM is unavailable.
7. Pushes update to all connected browsers via SSE

### Telegram Bot (Two-Way)
Crucix doubles as an interactive Telegram bot. Beyond sending alerts, it responds to commands directly from your chat:

| Command | What It Does |
|---------|-------------|
| `/status` | System health, last sweep time, source status, LLM status |
| `/sweep` | Trigger a manual sweep cycle |
| `/brief` | Compact text summary of the latest intelligence (direction, key metrics, top OSINT) |
| `/portfolio` | Portfolio status (if Alpaca connected) |
| `/alerts` | Recent alert history with tiers |
| `/mute` / `/mute 2h` | Silence alerts for 1h (or custom duration) |
| `/unmute` | Resume alerts |
| `/help` | Show all available commands |

This requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. The bot polls for messages every 5 seconds (configurable via `TELEGRAM_POLL_INTERVAL`).

### Discord Bot (Two-Way)

Crucix also supports Discord as a full-featured bot with slash commands and rich embed alerts. It mirrors the Telegram bot's capabilities with Discord-native formatting.

| Command | What It Does |
|---------|-------------|
| `/status` | System health, last sweep time, source status, LLM status |
| `/sweep` | Trigger a manual sweep cycle |
| `/brief` | Compact text summary of the latest intelligence |
| `/portfolio` | Portfolio status (if Alpaca connected) |

Alerts are delivered as rich embeds with color-coded sidebars: red for FLASH, yellow for PRIORITY, blue for ROUTINE. Each embed includes signal details, confidence scores, and cross-domain correlations.

**Setup requires:** `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, and optionally `DISCORD_GUILD_ID` for instant slash command registration. See [API Keys Setup](#api-keys-setup) for details.

**Webhook fallback:** If you don't want to run a full bot, set `DISCORD_WEBHOOK_URL` instead. This enables one-way alerts (no slash commands) with zero dependencies — no `discord.js` needed.

**Optional dependency:** The full bot requires `discord.js`. Install it with `npm install discord.js`. If it's not installed, Crucix automatically falls back to webhook-only mode.

### Optional LLM Layer
Connect any of 8 LLM providers for enhanced analysis:
- **AI trade ideas** — quantitative analyst producing 5-8 actionable ideas citing specific data
- **Smarter alert evaluation** — LLM classifies signals into FLASH/PRIORITY/ROUTINE tiers with cross-domain correlation and confidence scoring
- Providers: Anthropic Claude, OpenAI, Google Gemini, OpenRouter (Unified API), OpenAI Codex (ChatGPT subscription), MiniMax, Mistral, Grok
- Graceful fallback — when LLM is unavailable, a rule-based engine takes over alert evaluation. LLM failures never crash the sweep cycle.

---

## API Keys Setup

Copy `.env.example` to `.env` at the project root:

```bash
cp .env.example .env
```

### Required for Best Results (all free)

| Key | Source | How to Get |
|-----|--------|------------|
| `FRED_API_KEY` | Federal Reserve Economic Data | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — instant, free |
| `FIRMS_MAP_KEY` | NASA FIRMS (satellite fire data) | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/area/) — instant, free |
| `EIA_API_KEY` | US Energy Information Administration | [api.eia.gov](https://www.eia.gov/opendata/register.php) — instant, free |

These three unlock the most valuable economic and satellite data. Each takes about 60 seconds to register.

### Optional (enable additional sources)

| Key | Source | How to Get |
|-----|--------|------------|
| `ACLED_EMAIL` + `ACLED_PASSWORD` | Armed conflict event data | [acleddata.com/register](https://acleddata.com/register/) — free, OAuth2 |
| `AISSTREAM_API_KEY` | Maritime AIS vessel tracking | [aisstream.io](https://aisstream.io/) — free |
| `ADSBX_RAPIDAPI_KEY` | ADS-B Exchange (unfiltered, incl. military) as the aircraft feed; replaces OpenSky + adsb.lol sampling | [RapidAPI](https://rapidapi.com/adsbx/api/adsbexchange-com1) — Community API ~$10/mo for 10k req, non-commercial licence |
| `VIRUSTOTAL_API_KEY` | Investigate: domain/IP/hash reputation | [virustotal.com](https://www.virustotal.com/gui/join-us) — free |
| `SHODAN_API_KEY` | Investigate: full host/service data | [account.shodan.io](https://account.shodan.io/) — free tier |
| `OPENCORPORATES_API_TOKEN` | Investigate: company registry | [opencorporates.com](https://opencorporates.com/api_accounts/new) — free for non-commercial |
| `HIBP_API_KEY` | Investigate: breach exposure per email | [haveibeenpwned.com/API/Key](https://haveibeenpwned.com/API/Key) — paid |
| `NUMVERIFY_API_KEY` | Investigate: phone carrier / line type | [numverify.com](https://numverify.com/) — free tier |
| `GITHUB_TOKEN` | Investigate: higher GitHub API rate limit for handle lookups | [github.com/settings/tokens](https://github.com/settings/tokens) — free, no scopes |
| `OPENSANCTIONS_API_KEY` | Investigate: wallet + entity sanctions screening | [opensanctions.org/api](https://www.opensanctions.org/api/) — free for non-commercial |

### LLM Provider (optional, for AI-enhanced ideas)

Set `LLM_PROVIDER` to one of: `anthropic`, `openai`, `gemini`, `codex`, `openrouter`, `minimax`, `mistral`, `grok`

| Provider | Key Required | Default Model |
|----------|-------------|---------------|
| `anthropic` | `LLM_API_KEY` | claude-sonnet-4-6 |
| `openai` | `LLM_API_KEY` | gpt-5.4 |
| `gemini` | `LLM_API_KEY` | gemini-3.1-pro |
| `openrouter` | `LLM_API_KEY` | openrouter/auto |
| `codex` | None (uses `~/.codex/auth.json`) | gpt-5.3-codex |
| `minimax` | `LLM_API_KEY` | MiniMax-M2.5 |
| `mistral` | `LLM_API_KEY` | mistral-large-latest |
| `grok` | `LLM_API_KEY` | grok-4-latest |

For Codex, run `npx @openai/codex login` to authenticate via your ChatGPT subscription.

### Telegram Bot + Alerts (optional)

| Key | How to Get |
|-----|------------|
| `TELEGRAM_BOT_TOKEN` | Create via [@BotFather](https://t.me/BotFather) on Telegram |
| `TELEGRAM_CHAT_ID` | Get via [@userinfobot](https://t.me/userinfobot) |
| `TELEGRAM_CHANNELS` | *(Optional)* Comma-separated extra channel IDs to monitor beyond the 17 built-in channels |
| `TELEGRAM_POLL_INTERVAL` | *(Optional)* Bot command polling interval in ms (default: 5000) |

### Discord Bot + Alerts (optional)

| Key | How to Get |
|-----|------------|
| `DISCORD_BOT_TOKEN` | Create at [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CHANNEL_ID` | Right-click channel in Discord (Developer Mode on) → Copy Channel ID |
| `DISCORD_GUILD_ID` | *(Optional)* Right-click server → Copy Server ID. Enables instant slash command registration (otherwise takes up to 1 hour for global commands) |
| `DISCORD_WEBHOOK_URL` | *(Optional)* Channel Settings → Integrations → Webhooks → New Webhook → Copy URL. Use this for alert-only mode without a bot |

**Discord bot setup:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Go to **Bot** → click **Reset Token** → copy the token to `DISCORD_BOT_TOKEN`
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Go to **OAuth2** → **URL Generator** → select `bot` + `applications.commands` scopes → select `Send Messages` + `Embed Links` permissions
5. Copy the generated URL and open it in your browser to invite the bot to your server
6. Install the dependency: `npm install discord.js`

Alerts work with or without an LLM on both Telegram and Discord. With an LLM configured, signal evaluation is richer and more context-aware. Without one, a deterministic rule engine evaluates signals based on severity, cross-domain correlation, and signal counts.

### Without Any Keys

Crucix still works with zero API keys. 18+ sources require no authentication at all. Sources that need keys return structured errors and the rest of the sweep continues normally.

---

## Architecture

```
crucix/
├── server.mjs                 # Express dev server (SSE, auto-refresh, LLM, bot commands)
├── crucix.config.mjs          # Configuration with env var overrides + delta thresholds
├── diag.mjs                   # Diagnostic script — run if server fails to start
├── .env.example               # All documented env vars
├── package.json               # Runtime: express | Optional: discord.js
├── docs/                      # Screenshots for README
│
├── apis/
│   ├── briefing.mjs           # Master orchestrator — runs all 27 sources in parallel
│   ├── save-briefing.mjs      # CLI: save timestamped + latest.json
│   ├── BRIEFING_PROMPT.md     # Intelligence synthesis protocol
│   ├── BRIEFING_TEMPLATE.md   # Briefing output structure
│   ├── utils/
│   │   ├── fetch.mjs          # safeFetch() — timeout, retries, abort, auto-JSON
│   │   └── env.mjs            # .env loader (no dotenv dependency)
│   └── sources/               # 27 self-contained source modules
│       ├── borderingest.mjs   # Border Watch: read-only bridge to the Python ingestion API
│       ├── gdelt.mjs          # Each exports briefing() → structured data
│       ├── fred.mjs           # Can run standalone: node apis/sources/fred.mjs
│       ├── space.mjs          # CelesTrak satellite tracking
│       ├── yfinance.mjs       # Yahoo Finance — free live market data
│       └── ...                # 23 more
│
├── dashboard/
│   ├── inject.mjs             # Data synthesis + standalone HTML injection
│   └── public/
│       └── jarvis.html        # Self-contained Jarvis HUD
│
├── lib/
│   ├── llm/                   # LLM abstraction (8 providers, raw fetch, no SDKs)
│   │   ├── provider.mjs       # Base class
│   │   ├── anthropic.mjs      # Claude
│   │   ├── openai.mjs         # GPT
│   │   ├── gemini.mjs         # Gemini
│   │   ├── grok.mjs           # Grok
│   │   ├── openrouter.mjs     # OpenRouter (Unified API)
│   │   ├── codex.mjs          # Codex (ChatGPT subscription)
│   │   ├── minimax.mjs        # MiniMax (M2.5, 204K context)
│   │   ├── mistral.mjs        # Mistral AI
│   │   ├── ideas.mjs          # LLM-powered trade idea generation
│   │   └── index.mjs          # Factory: createLLMProvider()
│   ├── delta/                 # Change tracking between sweeps
│   │   ├── engine.mjs         # Delta computation — semantic dedup, configurable thresholds, severity scoring
│   │   ├── memory.mjs         # Hot memory (3 runs, atomic writes) + cold storage (daily archives)
│   │   └── index.mjs          # Re-exports
│   └── alerts/
│       ├── telegram.mjs       # Multi-tier alerts (FLASH/PRIORITY/ROUTINE) + two-way bot commands
│       └── discord.mjs        # Discord bot (slash commands, rich embeds) + webhook fallback
│
├── ingest/                    # Border Watch ingestion service (Python, own Dockerfile)
│   ├── crucix_ingest/         # registry, polite HTTP client, feed parsers, extraction, NER, geo/violence scoring, baselines, API
│   │   └── data/              # sources.seed.json (source registry) + border_regions.json (gazetteer)
│   └── tests/                 # pytest suite with recorded feed/dataset fixtures
│
└── runs/                      # Runtime data (gitignored)
    ├── latest.json            # Most recent sweep output
    ├── memory/                # Delta memory (hot.json + cold/YYYY-MM-DD.json)
    └── ingest/                # Ingestion SQLite DB + raw HTML snapshots
```

### Design Principles
- **Pure ESM** — every file is `.mjs` with explicit imports
- **Minimal dependencies** — Express is the only runtime dependency. `discord.js` is optional (for Discord bot). LLM providers use raw `fetch()`, no SDKs.
- **Parallel execution** — `Promise.allSettled()` fires all 27 sources simultaneously
- **Graceful degradation** — missing keys produce errors, not crashes. LLM failures don't kill sweeps.
- **Each source is standalone** — run `node apis/sources/gdelt.mjs` to test any source independently
- **Self-contained dashboard** — the HTML file works with or without the server

---

## Data Sources (27)

### Tier 1: Core OSINT & Geopolitical (11)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **GDELT** | Global news events, conflict mapping (100+ languages) via the 15-minute export/GKG snapshots | None |
| **OpenSky** | Real-time ADS-B flight tracking, one global pull partitioned into 10 hotspot regions with up to 150 individual tracks each (falls back to adsb.lol point samples taken in a paced background rotation, marked `fallback` and tagged with their age, when OpenSky is unreachable; with `ADSBX_RAPIDAPI_KEY` set, ADS-B Exchange samples every theater instead) | Optional (OAuth2, 10x quota) |
| **NASA FIRMS** | Satellite fire/thermal anomaly detection (3hr latency) | Free key |
| **Maritime/AIS** | Vessel tracking, dark ships, sanctions evasion | Free key |
| **Safecast** | Citizen-science radiation monitoring near 6 nuclear sites | None |
| **ACLED** | Armed conflict events: battles, explosions, protests | Free (OAuth2) |
| **ReliefWeb** | UN humanitarian crisis tracking (API v2 with `RELIEFWEB_APPNAME`, else public RSS → HDX) | Optional |
| **WHO** | Disease outbreaks and health emergencies | None |
| **OFAC** | US Treasury sanctions (SDN list) | None |
| **OpenSanctions** | Aggregated global sanctions (30+ sources) | Partial |
| **ADS-B Exchange** | Unfiltered flight tracking including military | Paid |

### Tier 2: Economic & Financial (7)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **FRED** | 22 key indicators: yield curve, CPI, VIX, fed funds, M2 | Free key |
| **US Treasury** | National debt, yields, fiscal data | None |
| **BLS** | CPI, unemployment, nonfarm payrolls, PPI | None |
| **EIA** | WTI/Brent crude, natural gas, inventories | Free key |
| **GSCPI** | NY Fed Global Supply Chain Pressure Index | None |
| **USAspending** | Federal spending and defense contracts | None |
| **UN Comtrade** | Strategic commodity trade flows between major powers | None |

### Tier 3: Weather, Environment, Tech, Social, SIGINT (7)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **NOAA/NWS** | Active US weather alerts | None |
| **EPA RadNet** | US government radiation monitoring | None |
| **USPTO Patents** | Patent filings in 7 strategic tech areas | None |
| **Bluesky** | Social sentiment on geopolitical/market topics | None |
| **Reddit** | Social sentiment from key subreddits | OAuth |
| **Telegram** | 17 curated OSINT/conflict/finance channels (web scraping, expandable via config) | None |
| **KiwiSDR** | Global HF radio receiver network (~600 receivers) | None |

### Tier 4: Space & Satellites (1)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **CelesTrak** | Satellite launches, ISS tracking, military constellations, Starlink/OneWeb counts | None |

### Tier 5: Live Market Data (1)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **Yahoo Finance** | Real-time prices: SPY, QQQ, BTC, Gold, WTI, VIX + 9 more | None |

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `node --trace-warnings server.mjs` | Start dashboard with auto-refresh |
| `npm run sweep` | `node apis/briefing.mjs` | Run a single sweep, output JSON to stdout |
| `npm run inject` | `node dashboard/inject.mjs` | Inject latest data into static HTML |
| `npm run brief:save` | `node apis/save-briefing.mjs` | Run sweep + save timestamped JSON |
| `npm run diag` | `node diag.mjs` | Run diagnostics (Node version, imports, port check) |
| `npm run ingest` | `python -m crucix_ingest serve` | Start the Border Watch ingestion service (needs the `ingest/` venv active) |
| `npm run ingest:poll` | `python -m crucix_ingest poll` | One polling pass over every enabled source |
| `npm run ingest:test` | `cd ingest && python -m pytest` | Ingestion test suite (recorded fixtures, no network) |

---

## Configuration

All settings are in `.env` with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3117` | Dashboard server port |
| `REFRESH_INTERVAL_MINUTES` | `15` | Auto-refresh interval |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | anonymous | OpenSky OAuth2 API client (raises quota 400 → 4,000 credits/day) |
| `OPENSKY_MIN_INTERVAL_MINUTES` | `15` | Minimum spacing between OpenSky global pulls (4 credits each) |
| `ADSBX_RAPIDAPI_KEY` | unset | ADS-B Exchange RapidAPI key; when set, aircraft theaters are sampled from ADS-B Exchange instead of OpenSky/adsb.lol |
| `ADSBX_DAILY_BUDGET` | `300` | Max ADS-B Exchange requests per UTC day (Community API is 10,000/month) |
| `AIR_SAMPLE_PACE_MS` | `8000` | Delay between aggregator point samples; the 33 theater points are sampled in a continuous background rotation (~4.5 min per lap at the default) and each sweep reports the latest result per theater with its age. adsb.lol allows only a handful of requests per minute from a cloud IP (HTTP 429, no `Retry-After`) |
| `INGEST_API_URL` | `http://127.0.0.1:3118` | Border Watch ingestion service the dashboard reads from |
| `INGEST_*` | see `.env.example` | Python ingestion service: bind address, poll interval, NER, translation, anomaly thresholds |
| `LLM_PROVIDER` | disabled | `anthropic`, `openai`, `gemini`, `codex`, `openrouter`, `minimax`, `mistral`, or `grok` |
| `LLM_API_KEY` | — | API key (not needed for codex) |
| `LLM_MODEL` | per-provider default | Override model selection |
| `TELEGRAM_BOT_TOKEN` | disabled | For Telegram alerts + bot commands |
| `TELEGRAM_CHAT_ID` | — | Your Telegram chat ID |
| `TELEGRAM_CHANNELS` | — | Extra channel IDs to monitor (comma-separated) |
| `TELEGRAM_POLL_INTERVAL` | `5000` | Bot command polling interval (ms) |
| `DISCORD_BOT_TOKEN` | disabled | For Discord alerts + slash commands |
| `DISCORD_CHANNEL_ID` | — | Discord channel for alerts |
| `DISCORD_GUILD_ID` | — | Server ID (instant slash command registration) |
| `DISCORD_WEBHOOK_URL` | — | Webhook URL (alert-only fallback, no bot needed) |

Delta engine thresholds (how sensitive the system is to changes between sweeps) can be customized in `crucix.config.mjs` under the `delta.thresholds` section. The defaults are tuned to filter out noise while catching meaningful moves.

---

## API Endpoints

When running `npm run dev`:

| Endpoint | Description |
|----------|-------------|
| `GET /` | Jarvis HUD dashboard |
| `GET /api/data` | Current synthesized intelligence data (JSON) |
| `GET /api/health` | Server status, uptime, source count, LLM status, ingestion service status |
| `GET /api/border` | Border Watch panel data (anomalies, regions, articles, baselines) from the last sweep |
| `GET /api/ingest/*` | Read-only proxy to the ingestion API (allow-listed paths and query params only) |
| `GET /events` | SSE stream for live push updates |
| `GET /api/investigate?target=<domain\|ip\|hash>` | On-demand OSINT dossier (`&type=company` for registry search) |
| `GET /api/investigate/status` | Which keyed enrichment sources are configured |
| `GET /api/typosquat` | Registered look-alike domains for the watchlist |
| `GET /api/cartels` | Current cartel-map summary (status, counts, organizations, wars, recent entries, disclaimer) |
| `GET /api/cartels/geo` | Cartel-map geometry (polygons, points, lines) for the CARTELS tab; 404 until the first successful fetch |

---

## Troubleshooting

### `npm run dev` exits silently (no output, no error)

This is a known issue where npm's script runner can swallow errors, particularly on Windows PowerShell. Try these in order:

**1. Run Node directly (bypasses npm):**
```bash
node --trace-warnings server.mjs
```
This is functionally identical to `npm run dev` but gives you full error output.

**2. Run the diagnostic script:**
```bash
node diag.mjs
```
This tests every import one by one, checks your Node.js version, and verifies port 3117 is available. It will tell you exactly what's failing.

**3. Check if port 3117 is already in use:**

A previous Crucix instance may still be running in the background.

```powershell
# Windows PowerShell
netstat -ano | findstr 3117
taskkill /F /PID <the_PID_from_above>

# Or kill all Node processes
taskkill /F /IM node.exe
```

```bash
# macOS / Linux
lsof -ti:3117 | xargs kill
```

Then try starting again. You can also change the port by setting `PORT=3118` in your `.env` file.

**4. Check Node.js version:**
```bash
node --version
```
Crucix requires Node.js 22 or later. If you have an older version, download the latest LTS from [nodejs.org](https://nodejs.org/).

### Dashboard shows empty panels after first start

This is normal — the first sweep takes 30–60 seconds to query all 27 sources. The dashboard will populate automatically once the sweep completes. Check the terminal for sweep progress logs.

### Some sources show errors

Expected behavior. Sources that require API keys will return structured errors if the key isn't set. The rest of the sweep continues normally. Check the Source Integrity section in the dashboard (or the server logs) to see which sources failed and why. The 3 most impactful free keys to add are `FRED_API_KEY`, `FIRMS_MAP_KEY`, and `EIA_API_KEY`.

OpenSky meters `/states/all` in credits: 400/day anonymous, 4,000/day with an OAuth2 API client, and a global pull costs 4 credits. Crucix makes exactly one global pull per sweep (≈384 credits/day at the default 15-minute interval), so anonymous use fits under the cap with little headroom. If the sweep interval is shorter, or another process on the same IP is also hitting OpenSky, you will see `HTTP 429` with a cooldown of several hours. Crucix does not try to evade that limit: it honors the `x-rate-limit-retry-after-seconds` header, skips OpenSky until the cooldown expires, and keeps serving the last good snapshot (flagged `status: stale` in source health) so the flight layer does not go blank. To lift the ceiling, create an API client at https://opensky-network.org/my-opensky (Account → API Client) and set `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`.

### Telegram bot not responding to commands

Make sure both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`. The bot only responds to messages from the configured chat ID (security measure). You should see `[Crucix] Telegram alerts enabled` and `[Crucix] Bot command polling started` in the server logs on startup. If not, double-check your token with `curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe`.

### Discord bot not responding to slash commands

Check these in order:
1. Make sure `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set in `.env`
2. Verify `discord.js` is installed: `npm ls discord.js`. If missing, run `npm install discord.js`
3. If slash commands don't appear, set `DISCORD_GUILD_ID` — without it, global commands can take up to 1 hour to propagate. Guild-specific commands register instantly
4. Confirm the bot was invited with `bot` + `applications.commands` scopes and has `Send Messages` + `Embed Links` permissions in the target channel
5. Check server logs for `[Discord] Bot logged in as ...` on startup. If you see `[Discord] discord.js not installed`, install it and restart
6. **Webhook-only fallback:** If you just want alerts without slash commands, set `DISCORD_WEBHOOK_URL` instead of the bot token. No `discord.js` needed.

---

## Screenshots

The `docs/` folder contains dashboard screenshots referenced by this README:

| File | Description |
|------|-------------|
| `docs/dashboard.png` | Full dashboard — hero image at the top of this README |
| `docs/boot.png` | Cinematic boot sequence animation |
| `docs/map.png` | D3 world map with marker types and flight arcs |
| `docs/globe.png` | 3D WebGL globe view with atmosphere glow and markers |

To update them: run the dashboard, wait for a sweep to complete, then use your browser's DevTools (`F12` → `Ctrl+Shift+P` → "Capture full size screenshot") or a tool like [LICEcap](https://www.cockos.com/licecap/) for GIFs.

---

## Contributing

Found a bug? Want to add a 28th source? PRs welcome. Each source is a standalone module in `apis/sources/` — just export a `briefing()` function that returns structured data and add it to the orchestrator in `apis/briefing.mjs`.

If you find this useful, a star helps others find it too.

For contribution guidelines, review expectations, and source-add rules, see `CONTRIBUTING.md`. For security reports, see `SECURITY.md`.

## Contact

For partnerships, integrations, or other non-issue inquiries, you can reach me at `celesthioailabs@gmail.com`.

For bugs and feature requests, please use GitHub Issues so discussion stays visible and actionable.

---

## Star History

<a href="https://www.star-history.com/?repos=calesthio%2FCrucix&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=calesthio/Crucix&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=calesthio/Crucix&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=calesthio/Crucix&type=date&legend=top-left" />
  </picture>
</a>

---

## License

AGPL-3.0
