// Telegram forward / link graph + coordination detection (Pulpit model, ported to zero-dep Node).
//
// Built only from what the TelegramLive scraper already holds: each public message's channel, the
// channel it was forwarded from (if any), the t.me/ channels and external links in its text, and a
// content signature. Edges are counts of literal forwards/mentions/links; influence is PageRank over
// the channel graph; "coordination" is the same content (or the same external URL) appearing in two
// or more channels inside a short window. None of it says who is behind a channel or why.

export const COORD_WINDOW_MIN = 30;
export const MAX_DOMAIN_NODES = 20;
export const MAX_CLUSTERS = 40;
export const PAGERANK_D = 0.85;
export const PAGERANK_ITER = 40;
export const RULE = `Edges = literal forwards, t.me/ mentions and external links in scraped public posts. Influence = PageRank (d=${PAGERANK_D}) over the channel graph. Coordination = the same normalized text or external URL posted by ≥2 channels within ${COORD_WINDOW_MIN} min. Describes the public channel graph, not operators or intent.`;

const CHANNEL_RE = /^[A-Za-z0-9_]{5,32}$/;

/** Normalized content signature: lowercase, URLs/mentions/hashtags/emoji/punctuation stripped, first 160 chars. */
export function contentSignature(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#]\w+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E0}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 24) return null; // too short to be meaningful duplication
  return t.slice(0, 160);
}

export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }
export function tmeChannel(u) {
  try {
    const url = new URL(u);
    if (!/^(t\.me|telegram\.me)$/i.test(url.hostname.replace(/^www\./, ''))) return null;
    const seg = url.pathname.split('/').filter(Boolean);
    let c = seg[0] === 's' ? seg[1] : seg[0];
    if (!c || c.startsWith('+') || c === 'joinchat' || c === 'c') return null;
    c = c.replace(/^@/, '');
    return CHANNEL_RE.test(c) ? c : null;
  } catch { return null; }
}

/** PageRank on a directed weighted graph given as Map(from -> Map(to -> weight)). */
export function pagerank(nodes, edges, { d = PAGERANK_D, iter = PAGERANK_ITER } = {}) {
  const ids = [...nodes];
  const n = ids.length;
  if (!n) return new Map();
  const idx = new Map(ids.map((id, i) => [id, i]));
  let pr = new Array(n).fill(1 / n);
  const out = new Array(n).fill(0);
  for (const [from, tos] of edges) for (const w of tos.values()) out[idx.get(from)] += w;
  for (let k = 0; k < iter; k++) {
    const next = new Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) if (!out[i]) dangling += pr[i];
    for (const [from, tos] of edges) {
      const i = idx.get(from);
      if (!out[i]) continue;
      for (const [to, w] of tos) next[idx.get(to)] += d * pr[i] * (w / out[i]);
    }
    for (let i = 0; i < n; i++) next[i] += d * dangling / n;
    pr = next;
  }
  return new Map(ids.map((id, i) => [id, pr[i]]));
}

/**
 * @param messages  [{ id, channel, text, timestamp, url, views, fwdFrom?, links?: string[], hashtags?: string[] }]
 * @param monitored  channel usernames the scraper polls (so unmonitored referenced channels can be labelled)
 */
export function buildTelegramGraph(messages = [], monitored = [], { now = Date.now() } = {}) {
  const chan = new Map(); // channel -> stats
  const touch = (c, monitoredFlag) => {
    const k = c.toLowerCase();
    let e = chan.get(k);
    if (!e) { e = { id: k, label: c, monitored: Boolean(monitoredFlag), posts: 0, forwardsIn: 0, forwardsOut: 0, mentionsIn: 0, mentionsOut: 0, views: 0, linksOut: 0 }; chan.set(k, e); }
    if (monitoredFlag) { e.monitored = true; e.label = c; }
    return e;
  };
  for (const c of monitored) if (CHANNEL_RE.test(c)) touch(c, true);
  const edgeMap = new Map(); // key -> edge
  const addEdge = (from, to, type) => {
    if (!from || !to || from === to) return;
    const k = `${type}|${from}|${to}`;
    let e = edgeMap.get(k);
    if (!e) { e = { from, to, type, count: 0, kind: type === 'link' ? 'domain' : 'channel' }; edgeMap.set(k, e); }
    e.count++;
  };
  const domains = new Map();
  const bySig = new Map();
  const byUrl = new Map();
  let withForward = 0, withLinks = 0;

  for (const m of messages) {
    if (!m || !m.channel || !CHANNEL_RE.test(m.channel)) continue;
    const c = touch(m.channel, false);
    c.posts++;
    c.views += Number(m.views) || 0;
    const ts = Date.parse(m.timestamp);
    if (m.fwdFrom && CHANNEL_RE.test(m.fwdFrom) && m.fwdFrom.toLowerCase() !== c.id) {
      const src = touch(m.fwdFrom, false);
      src.forwardsOut++; c.forwardsIn++; withForward++;
      addEdge(src.id, c.id, 'forward');
    }
    const links = Array.isArray(m.links) ? m.links : [];
    if (links.length) withLinks++;
    const seenHere = new Set();
    for (const u of links) {
      const tme = tmeChannel(u);
      if (tme) {
        const t = touch(tme, false);
        if (t.id === c.id || seenHere.has(`c:${t.id}`)) continue;
        seenHere.add(`c:${t.id}`);
        t.mentionsIn++; c.mentionsOut++;
        addEdge(c.id, t.id, 'mention');
        continue;
      }
      const host = hostOf(u);
      if (!host || seenHere.has(`d:${host}`)) continue;
      seenHere.add(`d:${host}`);
      c.linksOut++;
      let dn = domains.get(host);
      if (!dn) { dn = { id: `d:${host}`, label: host, count: 0, channels: new Set() }; domains.set(host, dn); }
      dn.count++; dn.channels.add(c.id);
      addEdge(c.id, dn.id, 'link');
      if (Number.isFinite(ts)) {
        const key = u.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
        if (!byUrl.has(key)) byUrl.set(key, []);
        byUrl.get(key).push({ channel: c.id, ts, id: m.id, url: m.url, text: m.text });
      }
    }
    const sig = contentSignature(m.text);
    if (sig && Number.isFinite(ts)) {
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push({ channel: c.id, ts, id: m.id, url: m.url, text: m.text });
    }
  }

  // Coordination clusters: same content or same external URL in ≥2 distinct channels within the window.
  const clusters = [];
  const windowMs = COORD_WINDOW_MIN * 60_000;
  const consider = (kind, key, posts) => {
    const channels = new Set(posts.map(p => p.channel));
    if (channels.size < 2) return;
    const sorted = posts.slice().sort((a, b) => a.ts - b.ts);
    // Sliding window: any run of posts from ≥2 channels inside COORD_WINDOW_MIN counts.
    let best = null;
    for (let i = 0; i < sorted.length; i++) {
      const run = [sorted[i]];
      const chans = new Set([sorted[i].channel]);
      for (let j = i + 1; j < sorted.length && sorted[j].ts - sorted[i].ts <= windowMs; j++) { run.push(sorted[j]); chans.add(sorted[j].channel); }
      if (chans.size >= 2 && (!best || chans.size > best.chans.size)) best = { run, chans };
    }
    const span = sorted[sorted.length - 1].ts - sorted[0].ts;
    clusters.push({
      kind, key: kind === 'url' ? key : undefined,
      sample: String(sorted[0].text || '').slice(0, 220),
      channels: [...channels].map(ch => ({ channel: chan.get(ch)?.label || ch, posts: posts.filter(p => p.channel === ch).length, first: new Date(Math.min(...posts.filter(p => p.channel === ch).map(p => p.ts))).toISOString() })),
      posts: sorted.slice(0, 8).map(p => ({ channel: chan.get(p.channel)?.label || p.channel, ts: new Date(p.ts).toISOString(), url: p.url })),
      spanMin: Math.round(span / 60_000),
      withinWindow: Boolean(best),
      tightestMin: best ? Math.round((best.run[best.run.length - 1].ts - best.run[0].ts) / 60_000) : null,
      first: new Date(sorted[0].ts).toISOString(),
    });
  };
  for (const [sig, posts] of bySig) consider('text', sig, posts);
  for (const [u, posts] of byUrl) consider('url', u, posts);
  clusters.sort((a, b) => (b.withinWindow === true) - (a.withinWindow === true) || b.channels.length - a.channels.length || (a.tightestMin ?? 1e9) - (b.tightestMin ?? 1e9) || b.first.localeCompare(a.first));
  const coordinated = clusters.filter(c => c.withinWindow);

  // PageRank over channel↔channel edges only (forwards + mentions), weight = count.
  const adj = new Map();
  for (const e of edgeMap.values()) {
    if (e.kind !== 'channel') continue;
    if (!adj.has(e.from)) adj.set(e.from, new Map());
    adj.get(e.from).set(e.to, (adj.get(e.from).get(e.to) || 0) + e.count);
  }
  const pr = pagerank(chan.keys(), adj);
  const prMax = Math.max(1e-9, ...pr.values());

  const channelNodes = [...chan.values()].map(c => ({
    ...c, kind: 'channel', pagerank: Number((pr.get(c.id) || 0).toFixed(4)), influence: Number(((pr.get(c.id) || 0) / prMax).toFixed(3)),
    degree: c.forwardsIn + c.forwardsOut + c.mentionsIn + c.mentionsOut,
  })).sort((a, b) => b.pagerank - a.pagerank || b.posts - a.posts);
  const domainNodes = [...domains.values()].sort((a, b) => b.channels.size - a.channels.size || b.count - a.count).slice(0, MAX_DOMAIN_NODES)
    .map(d => ({ id: d.id, label: d.label, kind: 'domain', count: d.count, channels: d.channels.size }));
  const keep = new Set([...channelNodes.map(n => n.id), ...domainNodes.map(n => n.id)]);
  const edges = [...edgeMap.values()].filter(e => keep.has(e.from) && keep.has(e.to)).sort((a, b) => b.count - a.count);

  return {
    computedAt: new Date(now).toISOString(),
    messages: messages.length,
    monitored: monitored.filter(c => CHANNEL_RE.test(c)),
    nodes: [...channelNodes, ...domainNodes],
    edges,
    clusters: clusters.slice(0, MAX_CLUSTERS),
    summary: {
      channels: channelNodes.length,
      monitored: channelNodes.filter(n => n.monitored).length,
      referenced: channelNodes.filter(n => !n.monitored).length,
      domains: domains.size,
      forwards: edges.filter(e => e.type === 'forward').reduce((s, e) => s + e.count, 0),
      mentions: edges.filter(e => e.type === 'mention').reduce((s, e) => s + e.count, 0),
      links: edges.filter(e => e.type === 'link').reduce((s, e) => s + e.count, 0),
      postsWithForward: withForward,
      postsWithLinks: withLinks,
      coordinatedClusters: coordinated.length,
      duplicateClusters: clusters.length,
      topInfluence: channelNodes.slice(0, 5).map(n => ({ channel: n.label, influence: n.influence, monitored: n.monitored })),
    },
    rule: RULE,
  };
}
