// === PRC DELEGATIONS TAB (Chinese Delegation Tracker + SYNTHETIC overlay; served by /api/prcdel/*) ===
// Headlines, outlet names and scenario text are third-party / user-authored → esc() on every string.
// Self-contained like the SITREP / Requirements tabs: owns CSS + state and wraps tabCounts /
// renderLeftRail / renderLower (global function bindings from jarvis.html are reassignable).
(function(){
  if(typeof renderLower!=='function')return;
  const css=document.createElement('style');
  css.textContent=`
.pd-banner{font-family:var(--mono);font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:#ff80ab;border:1px solid rgba(255,64,129,0.4);background:rgba(255,64,129,0.07);padding:5px 8px;margin:0 0 8px}
.pd-banner.osint{color:#ffd54f;border-color:rgba(255,213,79,0.35);background:rgba(255,213,79,0.06)}
.pd-syn{display:inline-block;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:0.08em;color:#ff4081;border:1px solid rgba(255,64,129,0.55);background:rgba(255,64,129,0.1);padding:0 4px;margin-left:4px;vertical-align:1px}
.pd-osint{display:inline-block;font-family:var(--mono);font-size:8px;letter-spacing:0.08em;color:#ffd54f;border:1px solid rgba(255,213,79,0.45);padding:0 4px;margin-left:4px;vertical-align:1px}
.pd-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.pd-tools label{font-family:var(--mono);font-size:9px;color:var(--dim);display:flex;align-items:center;gap:4px;text-transform:uppercase;letter-spacing:0.06em}
.pd-tools select.inv-btn{padding:5px 6px}
.pd-del{display:flex;gap:8px;align-items:flex-start;padding:6px 6px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;border-left:2px solid transparent}
.pd-del:hover{background:rgba(100,240,200,0.04)}
.pd-del.off{opacity:0.4}
.pd-del.sel{border-left-color:var(--accent);background:rgba(100,240,200,0.05)}
.pd-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin-top:3px}
.pd-del .nm{font-size:11px;color:var(--text);line-height:1.3}
.pd-del .mt{font-family:var(--mono);font-size:9px;color:var(--dim);margin-top:2px}
.pd-poi{display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer}
.pd-poi:hover,.pd-poi.sel{background:rgba(255,64,129,0.07)}
.pd-poi .nm{font-size:11px;color:#ff80ab}
.pd-poi .mt{font-family:var(--mono);font-size:9px;color:var(--dim)}
.pd-sil{width:30px;height:38px;flex:0 0 auto;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.pd-sil svg{width:26px;height:32px;fill:rgba(200,210,220,0.35)}
.pd-sil.lg{width:64px;height:80px}.pd-sil.lg svg{width:56px;height:70px}
.pd-map{position:relative;height:clamp(460px,62vh,720px);border:1px solid var(--border);background:radial-gradient(ellipse at center,rgba(4,12,20,1),rgba(2,4,8,1));overflow:hidden}
.pd-map svg{width:100%;height:100%;display:block}
#pdMapSvg .land{fill:rgba(180,200,210,0.08);stroke:rgba(200,220,230,0.18);stroke-width:0.6;vector-effect:non-scaling-stroke}
#pdMapSvg .graticule{fill:none;stroke:rgba(255,255,255,0.04);stroke-width:0.5;vector-effect:non-scaling-stroke}
#pdMapSvg .route{fill:none;stroke-width:1.8;vector-effect:non-scaling-stroke;opacity:0.85}
#pdMapSvg .route.syn{stroke-dasharray:6 4}
#pdMapSvg .track{fill:none;stroke:#ff4081;stroke-width:1.4;stroke-dasharray:2 3;vector-effect:non-scaling-stroke}
#pdMapSvg .stop{cursor:pointer;stroke:#02060a;stroke-width:1.2;vector-effect:non-scaling-stroke}
#pdMapSvg .stop.conc{stroke:#ffab40;stroke-width:2.6}
#pdMapSvg .ring{fill:none;pointer-events:none;stroke:#ffab40;stroke-width:1.4;vector-effect:non-scaling-stroke;animation:pdPulse 1.8s ease-out infinite}
#pdMapSvg .ev{cursor:pointer;fill:rgba(255,171,64,0.25);stroke:#ffab40;stroke-width:1;vector-effect:non-scaling-stroke}
#pdMapSvg .ev.syn{fill:rgba(255,64,129,0.25);stroke:#ff4081}
#pdMapSvg .ev.hot{fill:#ffab40}
#pdMapSvg .ev.syn.hot{fill:#ff4081}
#pdMapSvg .tk{fill:#ff4081;stroke:#02060a;stroke-width:0.8;vector-effect:non-scaling-stroke;cursor:pointer}
#pdMapSvg .lbl{fill:var(--text);font-family:var(--mono);pointer-events:none;paint-order:stroke;stroke:#02060a;stroke-width:2.5px}
@keyframes pdPulse{0%{opacity:0.9}100%{opacity:0}}
.pd-legend{position:absolute;left:8px;bottom:8px;font-family:var(--mono);font-size:9px;color:var(--dim);background:rgba(2,6,10,0.82);border:1px solid var(--border);padding:6px 8px;display:flex;flex-direction:column;gap:3px;pointer-events:none}
.pd-legend i{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px}
.pd-pop{position:absolute;z-index:5;width:340px;max-height:78%;overflow:auto;background:rgba(4,10,16,0.97);border:1px solid rgba(100,240,200,0.35);box-shadow:0 8px 30px rgba(0,0,0,0.6);padding:10px 12px;font-size:11px;color:var(--text)}
.pd-pop h4{margin:0 0 4px;font-size:12px;color:var(--accent)}
.pd-pop .x{position:absolute;right:6px;top:4px;cursor:pointer;color:var(--dim);font-size:14px}
.pd-pop .sub{font-family:var(--mono);font-size:9px;color:var(--dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em}
.pd-pop .sec{font-family:var(--mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent2);margin:8px 0 3px}
.pd-pop ul{margin:0;padding-left:14px}.pd-pop li{margin:2px 0}
.pd-pop a{color:var(--accent2)}
.pd-conc{border-left:2px solid #ffab40;background:rgba(255,171,64,0.07);padding:4px 6px;margin:3px 0}
.pd-conc.syn{border-left-color:#ff4081;background:rgba(255,64,129,0.07)}
.pd-tbl{width:100%;border-collapse:collapse;font-size:10.5px}
.pd-tbl th{font-family:var(--mono);font-size:8.5px;letter-spacing:0.08em;text-transform:uppercase;color:var(--dim);text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(4,10,16,0.98)}
.pd-tbl td{padding:4px 6px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:top;color:var(--text)}
.pd-tbl tr.hl td{background:rgba(255,64,129,0.06)}
.pd-tbl td.m{font-family:var(--mono);font-size:9.5px}
.pd-scroll{max-height:460px;overflow:auto}
.pd-sel{color:var(--accent2);cursor:pointer;border-bottom:1px dotted rgba(68,204,255,0.5)}
.pd-sel:hover{color:#fff}
.pd-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.pd-tabs .inv-btn.active{background:rgba(68,204,255,.2)}
.pd-chips{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0 8px}
.pd-chip{font-family:var(--mono);font-size:9px;padding:2px 6px;border:1px solid rgba(100,240,200,0.35);color:var(--accent)}
.pd-chip.miss{border-color:rgba(255,255,255,0.15);color:var(--dim);text-decoration:line-through}
.pd-dossier{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}
.pd-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:10.5px}
.pd-kv span{font-family:var(--mono);font-size:9px;color:var(--dim);text-transform:uppercase}
.pd-hop{font-family:var(--mono);font-size:8.5px;color:#02060a;background:var(--accent);padding:0 4px;margin-right:4px}
.pd-hop.h1{background:#44ccff}.pd-hop.h2{background:#ffab40}.pd-hop.h3,.pd-hop.h4{background:#ff4081}
.pd-sub-h{font-family:var(--mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin:12px 0 4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,0.06)}
.pd-ta{width:100%;min-height:280px;background:rgba(0,0,0,0.35);color:var(--text);border:1px solid var(--border);font-family:var(--mono);font-size:10.5px;padding:8px}
.pd-err{color:var(--danger);font-family:var(--mono);font-size:10px;margin-top:4px}
.regime-chip.pd-link{cursor:pointer}
.regime-chip.pd-link:hover{background:rgba(244,67,54,0.18)!important}
`;
  document.head.appendChild(css);

  const PALETTE=['#64f0c8','#44ccff','#b388ff','#ffd54f','#69f0ae','#4fc3f7','#f48fb1','#aed581','#90caf9','#ffcc80','#80deea','#ce93d8'];
  const DS=['travel','border','ss7','cdr','voter','vehicle'];
  const DSL={travel:'Travel',border:'Border',ss7:'SS7',cdr:'CDR',voter:'Voter',vehicle:'Vehicle'};
  const SIL='<svg viewBox="0 0 40 50"><circle cx="20" cy="16" r="9"/><path d="M3 50c0-11 8-18 17-18s17 7 17 18z"/></svg>';
  const PD={data:null,loading:false,err:null,win:null,syn:localStorage.getItem('pd_syn')!=='0',hidden:new Set(),sel:null,ds:'ss7',q:'',pivot:null,pivotFor:null,answer:false,tracks:true,editor:false,scenario:null,scErr:null,transform:null,pop:null};
  window.PD_STATE=PD;
  const active=()=>currentTab==='prcdel';
  const colorOf=d=>{const i=(PD.data?.delegations||[]).findIndex(x=>x.id===d.id);return d.synthetic?'#ff4081':PALETTE[Math.max(0,i)%PALETTE.length]};
  const visDel=()=>(PD.data?.delegations||[]).filter(d=>!PD.hidden.has(d.id));
  const evById=id=>(PD.data?.events||[]).find(e=>e.id===id);
  const persons=()=>PD.data?.synthetic?.persons||[];
  const personById=id=>persons().find(p=>p.id===id);
  const recById=id=>{const s=PD.data?.synthetic?.datasets;if(!s)return null;for(const k of DS){const r=s[k].find(x=>x.id===id);if(r)return{kind:k,rec:r}}return null};
  const fmtD=d=>d?String(d).slice(0,10):'—';
  const fmtT=t=>t?String(t).replace('T',' ').replace(/:\d\dZ$/,'Z'):'—';
  const sel=(t,v,label)=>v?`<span class="pd-sel" data-t="${esc(t)}" data-v="${esc(v)}" title="Pivot on ${esc(t)}">${esc(label??v)}</span>`:'—';

  async function load(force){
    if(PD.loading)return;PD.loading=true;PD.err=null;
    try{
      if(force)await fetch('/api/prcdel/refresh',{method:'POST'});
      const q=new URLSearchParams({synthetic:PD.syn?'1':'0'});if(PD.win!=null)q.set('window',PD.win);
      const r=await fetch('/api/prcdel?'+q);const j=await r.json();
      if(!r.ok)throw new Error(j.error||r.status);
      PD.data=j;if(PD.win==null)PD.win=j.windowDays;
      if(!PD.syn){PD.sel=PD.sel?.type==='person'?null:PD.sel;PD.pivot=null}
    }catch(e){PD.err=e.message}
    PD.loading=false;
    if(active()){renderLeftRail();renderLower()}
  }
  async function loadPivot(q,label){
    PD.pivotFor={label,q};PD.pivot={loading:true};if(active())renderLower();
    try{const r=await fetch('/api/prcdel/pivot?'+new URLSearchParams({...q,window:PD.win??3}));const j=await r.json();if(!r.ok)throw new Error(j.error);PD.pivot=j}
    catch(e){PD.pivot={error:e.message}}
    if(active())renderLower();
  }
  function selectPerson(id){PD.sel={type:'person',id};PD.pop=null;loadPivot({person:id},personById(id)?.name||id)}

  // ── Left rail ───────────────────────────────────────────────────────────────
  function controlsPanel(){
    const d=PD.data;
    return `<div class="g-panel"><div class="sec-head"><h3>Delegation Tracker</h3><span class="badge">${d?`${d.counts.delegations} DEL · ${d.counts.stops} STOPS`:'LOADING'}</span></div>
      <div class="pd-tools">
        <label>Concurrent ±<select class="inv-btn" id="pdWin">${[0,1,2,3,5,7,14].map(n=>`<option value="${n}"${n===(PD.win??3)?' selected':''}>${n} d</option>`).join('')}</select></label>
        <label><input type="checkbox" id="pdSyn"${PD.syn?' checked':''}> Synthetic overlay</label>
        <label><input type="checkbox" id="pdTracks"${PD.tracks?' checked':''}> POI tracks</label>
      </div>
      <div class="pd-tools"><button class="inv-btn" data-pd="refresh">${PD.loading?'Loading…':'Refresh OSINT'}</button><button class="inv-btn" data-pd="all">Show all</button><button class="inv-btn" data-pd="none">Hide all</button><button class="inv-btn" data-pd="editor">Scenario</button>${PD.syn?'<a class="inv-btn" href="/api/prcdel/export" style="text-decoration:none">Export JSON</a>':''}</div>
      ${d?`<div class="inv-hint" style="font-size:9.5px">OSINT ${esc(fmtT(d.generatedAt))} · last ${d.days||30} d of headlines · ${d.counts.overlaps} concurrent-event matches${d.errors?.length?` · ${d.errors.length} query errors`:''}</div>`:''}
      ${PD.err?`<div class="pd-err">${esc(PD.err)}</div>`:''}
      <div style="margin-top:6px">${(d?.delegations||[]).map(x=>{const n=x.stops.reduce((a,s)=>a+(s.concurrent?.length||0),0);return `<div class="pd-del${PD.hidden.has(x.id)?' off':''}${PD.sel?.type==='del'&&PD.sel.id===x.id?' sel':''}" data-del="${esc(x.id)}">
        <span class="pd-dot" style="background:${colorOf(x)}"></span><div style="flex:1;min-width:0"><div class="nm">${esc(x.label)}${x.synthetic?'<span class="pd-syn">SYNTHETIC</span>':'<span class="pd-osint">OSINT</span>'}</div>
        <div class="mt">${esc(fmtD(x.first))} → ${esc(fmtD(x.last))} · ${x.stops.length} stop${x.stops.length===1?'':'s'} · ${esc((x.countries||[]).join(', '))}${n?` · <span style="color:#ffab40">${n} concurrent</span>`:''}</div></div>
        <span class="inv-btn" data-eye="${esc(x.id)}" style="padding:2px 6px;font-size:8px">${PD.hidden.has(x.id)?'SHOW':'HIDE'}</span></div>`}).join('')||'<div class="inv-hint">No delegations parsed yet.</div>'}</div>
    </div>`;
  }
  function poiPanel(){
    if(!PD.syn)return '';
    const syn=PD.data?.synthetic;if(!syn)return '';
    const pois=syn.persons.filter(p=>p.isPOI);
    return `<div class="g-panel"><div class="sec-head"><h3>Persons of Interest</h3><span class="badge" style="color:#ff4081;border-color:rgba(255,64,129,0.5)">SYNTHETIC · ${pois.length}</span></div>
      <div class="inv-hint" style="font-size:9.5px;margin-bottom:4px">One fictional person per delegation. Click to pivot their selectors across the six synthetic datasets and draw their track.</div>
      ${pois.map(p=>{const d=(PD.data.delegations||[]).find(x=>x.id===p.delegationId);return `<div class="pd-poi${PD.sel?.type==='person'&&PD.sel.id===p.id?' sel':''}" data-person="${esc(p.id)}"><div class="pd-sil">${SIL}</div><div style="min-width:0"><div class="nm">${esc(p.name)}<span class="pd-syn">SYN</span></div><div class="mt">${esc(p.role)}</div><div class="mt"><span class="pd-dot" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;background:${d?colorOf(d):'#888'}"></span>${esc(p.delegationLabel)}</div></div></div>`}).join('')}
    </div>`;
  }

  // ── Map ─────────────────────────────────────────────────────────────────────
  function mapPanel(){
    const d=PD.data;
    return `<div class="g-panel lp-wide"><div class="sec-head"><h3>Delegation Travel Map</h3><span class="badge">${d?`${visDel().length}/${d.delegations.length} SHOWN`:'…'}</span></div>
      <div class="pd-banner osint">OSINT layer: ${esc(d?.disclaimer||'Machine-extracted from news headlines.')}</div>
      ${PD.syn?`<div class="pd-banner">SYNTHETIC overlay on: pink items (scenario delegations, scenario events, POI tracks, all records below) are fictional test data.</div>`:''}
      <div class="pd-map" id="pdMapWrap"><svg id="pdMapSvg"></svg>
        <div class="pd-legend"><div><i style="background:#64f0c8;border-radius:50%"></i>Delegation stop (numbered by date) · line = route</div><div><i style="border:2px solid #ffab40;border-radius:50%"></i>Stop with concurrent PRC-linked event</div><div><i style="background:rgba(255,171,64,0.6);transform:rotate(45deg)"></i>PRC-linked event (OSINT)</div>${PD.syn?'<div><i style="background:#ff4081;transform:rotate(45deg)"></i>SYNTHETIC event / delegation / POI track</div>':''}</div>
        ${PD.pop?popupHtml():''}
      </div></div>`;
  }
  let svg,proj,path,root,zoom;
  function initMap(){
    const wrap=document.getElementById('pdMapWrap'),el=document.getElementById('pdMapSvg');
    if(!wrap||!el||!window.d3||!PD.data)return;
    const W=wrap.clientWidth||1000,H=wrap.clientHeight||560;
    svg=d3.select(el).attr('viewBox',`0 0 ${W} ${H}`);svg.selectAll('*').remove();
    const dels=visDel();
    const pts=[];dels.forEach(d=>d.stops.forEach(s=>pts.push([s.lon,s.lat])));
    if(PD.sel?.type==='person'){const p=personById(PD.sel.id);(p?.track||[]).forEach(t=>pts.push([t.lon,t.lat]))}
    pts.push([116.4,39.9]);
    const fit=pts.length>1?{type:'MultiPoint',coordinates:pts}:{type:'Sphere'};
    proj=d3.geoNaturalEarth1().fitExtent([[40,30],[W-40,H-30]],fit);
    if(proj.scale()>2400)proj.scale(2400);
    path=d3.geoPath(proj);
    root=svg.append('g');
    const base=root.append('g'),lay=root.append('g');
    zoom=d3.zoom().scaleExtent([0.5,40]).on('zoom',ev=>{PD.transform=ev.transform;root.attr('transform',ev.transform);scale(ev.transform.k)});
    svg.call(zoom).on('click',()=>{if(PD.pop){PD.pop=null;renderLower()}});
    if(PD.transform)svg.call(zoom.transform,PD.transform);
    base.append('path').datum(d3.geoGraticule().step([10,10])()).attr('class','graticule').attr('d',path);
    ctWorld().then(world=>{if(!world||!window.topojson)return;base.selectAll('path.land').data(topojson.feature(world,world.objects.countries).features).enter().append('path').attr('class','land').attr('d',path);lay.raise()});
    const k0=PD.transform?.k||1;
    const hotEv=new Set();dels.forEach(d=>d.stops.forEach(s=>(s.concurrent||[]).forEach(c=>hotEv.add(c.eventId))));
    // routes (Beijing origin → stops)
    dels.forEach(d=>{
      const coords=[[116.4,39.9],...d.stops.map(s=>[s.lon,s.lat])];
      if(coords.length>1)lay.append('path').datum({type:'LineString',coordinates:coords}).attr('class','route'+(d.synthetic?' syn':'')).attr('stroke',colorOf(d)).attr('d',path);
    });
    // events
    (PD.data.events||[]).forEach(e=>{
      const xy=proj([e.lon,e.lat]);if(!xy)return;
      const hot=hotEv.has(e.id);
      if(!hot&&e.synthetic&&!dels.some(d=>d.synthetic))return;
      const g=lay.append('rect').attr('class',`ev pd-sym${e.synthetic?' syn':''}${hot?' hot':''}`).attr('x',-4).attr('y',-4).attr('width',8).attr('height',8)
        .attr('data-x',xy[0]+9).attr('data-y',xy[1]-9).attr('data-r','45').attr('transform',`translate(${xy[0]+9},${xy[1]-9}) scale(${1/Math.sqrt(k0)}) rotate(45)`);
      g.append('title').text(`${e.host}: ${e.headline}`);
      g.on('click',ev=>{ev.stopPropagation();PD.pop={type:'event',id:e.id,x:xy[0],y:xy[1]};renderLower()});
    });
    // synthetic POI tracks
    if(PD.syn&&PD.tracks){
      const showAll=PD.sel?.type!=='person';
      persons().filter(p=>p.isPOI&&(showAll?!PD.hidden.has(p.delegationId):p.id===PD.sel.id)).forEach(p=>{
        const t=(p.track||[]).filter(x=>Number.isFinite(x.lat));if(t.length<1)return;
        lay.append('path').datum({type:'LineString',coordinates:t.map(x=>[x.lon,x.lat])}).attr('class','track').attr('d',path).style('opacity',showAll?0.55:1);
        if(!showAll)t.forEach(x=>{const xy=proj([x.lon,x.lat]);if(!xy)return;const c=lay.append('circle').attr('class','tk pd-pin').attr('cx',xy[0]).attr('cy',xy[1]).attr('data-r',3).attr('r',3/Math.sqrt(k0));c.append('title').text(`SYNTHETIC · ${p.name} · ${x.ts} · ${x.label}`);c.on('click',ev=>{ev.stopPropagation();if(x.recordId){PD.pop={type:'rec',id:x.recordId,x:xy[0],y:xy[1]};renderLower()}})});
      });
    }
    // stops
    dels.forEach(d=>d.stops.forEach(s=>{
      const xy=proj([s.lon,s.lat]);if(!xy)return;
      const conc=(s.concurrent||[]).length>0;
      if(conc)lay.append('circle').attr('class','ring pd-pin').attr('cx',xy[0]).attr('cy',xy[1]).attr('data-r',11).attr('r',11/Math.sqrt(k0));
      const c=lay.append('circle').attr('class','stop pd-pin'+(conc?' conc':'')).attr('cx',xy[0]).attr('cy',xy[1]).attr('data-r',6).attr('r',6/Math.sqrt(k0)).attr('fill',colorOf(d));
      c.append('title').text(`${d.label} · #${s.seq} ${s.city} ${s.date}`);
      c.on('click',ev=>{ev.stopPropagation();PD.pop={type:'stop',del:d.id,id:s.id,x:xy[0],y:xy[1]};renderLower()});
      lay.append('text').attr('class','lbl pd-lbl').attr('x',xy[0]+8).attr('y',xy[1]+3).attr('data-fs',8.5).style('font-size',8.5/k0+'px').text(`${s.seq}·${s.city}`);
    }));
    const bj=proj([116.4,39.9]);if(bj){lay.append('circle').attr('class','pd-pin').attr('cx',bj[0]).attr('cy',bj[1]).attr('data-r',4).attr('r',4/Math.sqrt(k0)).attr('fill','#f44336');lay.append('text').attr('class','lbl pd-lbl').attr('x',bj[0]+7).attr('y',bj[1]+3).attr('data-fs',8.5).style('font-size',8.5/k0+'px').text('Beijing')}
  }
  function scale(k){
    if(!root)return;
    root.selectAll('.pd-pin').attr('r',function(){return +this.dataset.r/Math.sqrt(k)});
    root.selectAll('.pd-sym').attr('transform',function(){return `translate(${this.dataset.x},${this.dataset.y}) scale(${1/Math.sqrt(k)}) rotate(45)`});
    root.selectAll('.pd-lbl').style('font-size',function(){return (+this.dataset.fs||8)/k+'px'});
    const pop=document.querySelector('.pd-pop');if(pop&&PD.pop)placePop(pop);
  }
  function placePop(el){
    const wrap=document.getElementById('pdMapWrap');if(!wrap)return;
    const t=PD.transform||{k:1,x:0,y:0};const svgEl=document.getElementById('pdMapSvg');
    const vb=svgEl.viewBox.baseVal;const sx=svgEl.clientWidth/(vb.width||1),sy=svgEl.clientHeight/(vb.height||1),s=Math.min(sx,sy);
    const ox=(svgEl.clientWidth-vb.width*s)/2,oy=(svgEl.clientHeight-vb.height*s)/2;
    let x=ox+(PD.pop.x*t.k+t.x)*s+14,y=oy+(PD.pop.y*t.k+t.y)*s-20;
    const W=wrap.clientWidth,H=wrap.clientHeight;
    if(x+350>W)x=Math.max(6,x-370);y=Math.max(6,Math.min(y,H-el.offsetHeight-6));
    el.style.left=x+'px';el.style.top=y+'px';
  }
  function concHtml(s){
    return (s.concurrent||[]).map(c=>{const e=evById(c.eventId);if(!e)return '';return `<div class="pd-conc${e.synthetic?' syn':''}"><b>${esc(e.host)}</b>${e.synthetic?'<span class="pd-syn">SYNTHETIC</span>':''} · ${esc(fmtD(e.date))} (${c.gapDays>0?'+':''}${c.gapDays} d, ${c.match==='city'?'same city':'same country'})<br>${e.url?`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.headline)}</a>`:esc(e.headline)}${e.outlet?` <span style="color:var(--dim)">— ${esc(e.outlet)}</span>`:''}</div>`}).join('');
  }
  function popupHtml(){
    const p=PD.pop;let body='';
    if(p.type==='stop'){
      const d=(PD.data.delegations||[]).find(x=>x.id===p.del);const s=d?.stops.find(x=>x.id===p.id);if(!s)return '';
      const poi=PD.syn?persons().find(x=>x.isPOI&&x.delegationId===d.id):null;
      const poiHits=poi?(poi.track||[]).filter(t=>t.ts.slice(0,10)>=s.date&&t.ts.slice(0,10)<=s.date.replace(/\d\d$/,m=>String(+m+3).padStart(2,'0'))&&Math.abs(t.lat-s.lat)<0.6&&Math.abs(t.lon-s.lon)<0.6):[];
      body=`<h4>#${s.seq} ${esc(s.city)}, ${esc(s.country)}</h4><div class="sub">${esc(d.label)}${d.synthetic?' <span class="pd-syn">SYNTHETIC</span>':''} · ${esc(s.date)}${s.precision==='country'?' · country-level place':''}</div>
        <div class="sec">Reported meetings</div>${s.meetings?.length?`<ul>${s.meetings.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>`:'<div style="color:var(--dim)">No counterpart named in the headline(s).</div>'}
        <div class="sec">Concurrent PRC-linked events (±${PD.data.windowDays} d)</div>${concHtml(s)||'<div style="color:var(--dim)">None found in this window.</div>'}
        <div class="sec">Sources</div><ul>${(s.sources||[]).map(x=>`<li>${x.url?`<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.headline)}</a>`:esc(x.headline)} <span style="color:var(--dim)">${esc(x.outlet||'')} · ${esc(x.date||'')}</span></li>`).join('')}</ul>
        ${poi?`<div class="sec" style="color:#ff4081">Synthetic POI at this stop</div><div><span class="pd-sel" data-person="${esc(poi.id)}">${esc(poi.name)}</span> <span class="pd-syn">SYNTHETIC</span> — ${poiHits.length} SS7/border hits near ${esc(s.city)}</div>`:''}`;
    }else if(p.type==='event'){
      const e=evById(p.id);if(!e)return '';
      const stops=(PD.data.delegations||[]).flatMap(d=>d.stops.filter(s=>(s.concurrent||[]).some(c=>c.eventId===e.id)).map(s=>({d,s})));
      body=`<h4>${esc(e.host)}${e.synthetic?'<span class="pd-syn">SYNTHETIC</span>':''}</h4><div class="sub">PRC-linked event · ${esc(e.city)}, ${esc(e.country)} · ${esc(e.date)}</div>
        <div>${e.url?`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.headline)}</a>`:esc(e.headline)}${e.outlet?` <span style="color:var(--dim)">— ${esc(e.outlet)}</span>`:''}</div>
        <div class="sec">Concurrent delegation stops</div>${stops.length?`<ul>${stops.map(({d,s})=>`<li>${esc(d.label)} · #${s.seq} ${esc(s.city)} ${esc(s.date)}</li>`).join('')}</ul>`:'<div style="color:var(--dim)">No delegation stop within the window.</div>'}`;
    }else if(p.type==='rec'){
      const r=recById(p.id);if(!r)return '';
      body=`<h4>${esc(r.rec.id)} <span class="pd-syn">SYNTHETIC</span></h4><div class="sub">${esc(DSL[r.kind])} record</div>${recDetail(r.kind,r.rec)}`;
    }
    return `<div class="pd-pop" id="pdPop"><span class="x" data-pd="closepop">×</span>${body}</div>`;
  }

  // ── Records ─────────────────────────────────────────────────────────────────
  const COLS={
    travel:['PNR / booked','Passengers (passport · phone · email · rewards)','Itinerary','Payment'],
    border:['Time','Dir','Port','Traveler / passport','Visa','Application (stay · family · duration)'],
    ss7:['Time','MSISDN','IMSI','IMEI','TMSI','Op','TAC / cell','Lat/Lon · MGRS','Roam'],
    cdr:['Start','Type','A-party (reg. name · MSISDN · IMSI · IMEI)','B-party','Dur','Tower · TAC · MGRS'],
    voter:['Full name','Father / mother','Family reg. no.','ID document','DOB','Address','Phone / e-mail','Roll'],
    vehicle:['Plate','Vehicle','Owner / ID','Registration address','VIN · reg.'],
  };
  function recRow(k,r){
    switch(k){
      case 'travel':return [`${sel('pnr',r.pnr)}<br><span style="color:var(--dim)">${esc(fmtT(r.bookedAt))}</span><br><span style="color:var(--dim)">${esc(r.agency)}</span>`,
        (r.passengers||[]).map(p=>`${sel('name',p.name)} · ${sel('passport',p.passport)}<br>${sel('phone',p.phone)} · ${sel('email',p.email)}${p.rewards?` · ${esc(p.rewards.program)} ${sel('rewards',p.rewards.number)}`:''} · seat ${esc(p.seat)}`).join('<hr style="border:0;border-top:1px solid rgba(255,255,255,0.05);margin:3px 0">'),
        (r.segments||[]).map(s=>`${esc(s.flight)} ${esc(s.from)}→${esc(s.to)} ${esc(fmtT(s.depart))}`).join('<br>'),
        `${esc(r.payment?.masked)}<br>${sel('name',r.payment?.cardholder)}<br><span style="color:var(--dim)">${esc(r.payment?.billingAddress)}</span><br>${esc(r.payment?.currency)} ${esc(r.payment?.amount)}`];
      case 'border':{const a=r.visa?.application;return [esc(fmtT(r.ts)),esc(r.direction),`${esc(r.port)}<br><span style="color:var(--dim)">${esc(r.country)}</span>`,
        `<div style="display:flex;gap:6px"><div class="pd-sil" title="Passport photo placeholder (synthetic)">${SIL}</div><div>${sel('name',r.name)}<br>${sel('passport',r.passport?.number)} · ${esc(r.passport?.nationality)}<br><span style="color:var(--dim)">${esc(r.passport?.kind)} · DOB ${esc(r.dob)}</span></div></div>`,
        `${r.visa?.number?sel('visa',r.visa.number):'—'}<br><span style="color:var(--dim)">${esc(r.visa?.type)}${r.visa?.validUntil?` · valid to ${esc(r.visa.validUntil)}`:''}</span>`,
        a?`${sel('address',a.addressStaying)}<br>${esc(a.purpose)} · ${esc(a.durationDays)} d · inviter ${esc(a.inviter)}<br>${a.familyMembers?.length?'Family: '+a.familyMembers.map(f=>sel('name',f)).join(', ')+'<br>':''}${sel('phone',a.phone)} · ${sel('email',a.email)}`:'<span style="color:var(--dim)">no application (visa-exempt)</span>'];}
      case 'ss7':return [esc(fmtT(r.ts)),sel('phone',r.msisdn),sel('imsi',r.imsi),sel('imei',r.imei),esc(r.tmsi),esc(r.event),`${esc(r.tac)} · ${esc(r.eci)}<br><span style="color:var(--dim)">${esc(r.site)}</span>`,`${esc(r.lat)}, ${esc(r.lon)}<br>${esc(r.mgrs)}`,r.roaming?`home ${esc(r.homeNetwork)}`:'local'];
      case 'cdr':return [esc(fmtT(r.start)),esc(r.type),`${sel('name',r.aParty?.registeredName)}<br>${sel('phone',r.aParty?.msisdn)}<br>${sel('imsi',r.aParty?.imsi)} · ${sel('imei',r.aParty?.imei)}`,`${sel('name',r.bParty?.registeredName)}<br>${sel('phone',r.bParty?.msisdn)}`,esc(r.durationSec)+' s',`${esc(r.site)}<br>TAC ${esc(r.tac)} · ${esc(r.mgrs)}`];
      case 'voter':return [`${sel('name',r.fullName)}<br><span style="color:var(--dim)">${esc(r.country)}</span>`,`${r.fatherName?'F: '+sel('name',r.fatherName):''}${r.motherName?'<br>M: '+sel('name',r.motherName):''}${r.fatherOrHusbandName&&!r.fatherName?'F/H: '+esc(r.fatherOrHusbandName):''}${r.grandfatherName?'<br>GF: '+esc(r.grandfatherName):''}`||'—',
        r.familyRegistryNo?sel('familyId',r.familyRegistryNo):'—',`${esc(r.idDocument?.type)}<br>${sel('nationalId',r.idDocument?.number)}${r.driversLicense?`<br>DL ${esc(r.driversLicense)}`:''}`,esc(r.dob),sel('address',r.address),`${sel('phone',r.phone)}${r.email?'<br>'+sel('email',r.email):''}`,`${esc(r.authority)}<br><span style="color:var(--dim)">${esc(r.constituency)} · ${esc(r.pollingStation)}</span>`];
      case 'vehicle':return [sel('plate',r.plate),`${esc(r.color)} ${esc(r.make)} ${esc(r.model)} (${esc(r.year)})`,`${sel('name',r.owner)}<br>${sel('nationalId',r.ownerId)}`,sel('address',r.registrationAddress),`${esc(r.vin)}<br><span style="color:var(--dim)">${esc(r.registered)} · ${esc(r.country)}</span>`];
    }
    return [];
  }
  function recDetail(k,r){return `<table class="pd-tbl"><tbody>${COLS[k].map((c,i)=>`<tr><th style="position:static">${esc(c)}</th><td>${recRow(k,r)[i]}</td></tr>`).join('')}</tbody></table>`}
  function recTable(k,rows,extra){
    return `<div class="pd-scroll"><table class="pd-tbl"><thead><tr><th>ID</th>${extra?'<th>Hop / via</th>':''}${COLS[k].map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(({rec,hit})=>`<tr><td class="m">${esc(rec.id)}</td>${extra?`<td class="m"><span class="pd-hop h${hit.hop}">H${hit.hop}</span>${esc(hit.via?.t)}<br><span style="color:var(--dim)">${esc(String(hit.via?.v||'').slice(0,28))}</span></td>`:''}${recRow(k,rec).map(c=>`<td class="${k==='ss7'||k==='cdr'?'m':''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function dossierPanel(){
    if(!PD.syn||!PD.pivotFor)return '';
    const pv=PD.pivot;const person=PD.sel?.type==='person'?personById(PD.sel.id):null;
    let body='';
    if(!pv||pv.loading)body='<div class="inv-hint">Pivoting…</div>';
    else if(pv.error)body=`<div class="pd-err">${esc(pv.error)}</div>`;
    else{
      const syn=PD.data.synthetic;
      const groups=DS.map(k=>({k,rows:pv.records.filter(h=>h.kind===k).map(h=>({hit:h,rec:syn.datasets[k].find(r=>r.id===h.id)})).filter(x=>x.rec)}));
      const head=person?`<div class="pd-dossier"><div class="pd-sil lg" title="Passport photo placeholder (synthetic)">${SIL}</div><div class="pd-kv">
          <span>Name</span><b style="color:#ff80ab">${esc(person.name)} <span class="pd-syn">SYNTHETIC</span></b>
          <span>Role</span><b>${esc(person.role)}</b><span>Delegation</span><b>${esc(person.delegationLabel)}</b>
          ${person.passport?`<span>Passport</span><b>${esc(person.passport.number)} · ${esc(person.passport.kind)} · CN</b>`:''}<span>DOB</span><b>${esc(person.dob||'—')}</b>
          <span>Route</span><b>${esc((person.route||[]).map(r=>`${r.city} ${r.date}`).join(' → '))}</b>
          <span>Start selectors</span><b>${pv.seeds.map(s=>`${esc(s.t)}: ${esc(s.v)}`).join(' · ')}</b></div></div>`
        :`<div class="pd-kv" style="margin-bottom:8px"><span>Selector pivot</span><b>${pv.seeds.map(s=>`${esc(s.t)}: ${esc(s.v)}`).join(' · ')}</b></div>`;
      const chips=`<div class="pd-chips">${DS.map(k=>`<span class="pd-chip${pv.byKind[k]?'':' miss'}">${DSL[k]} ${pv.byKind[k]||0}</span>`).join('')}</div>`;
      const answer=person?`<div class="pd-tools"><label><input type="checkbox" id="pdAnswer"${PD.answer?' checked':''}> Show answer key (ground truth)</label></div>${PD.answer?`<div class="pd-conc syn">Ground truth for this fictional person — records generated <i>about them</i>: ${DS.map(k=>`${DSL[k]} ${person.coverage?.[k]||0}`).join(' · ')}. Absent from: <b>${esc((person.absentFrom||[]).map(k=>DSL[k]).join(', ')||'none')}</b>. ${person.localSims?.length?`Local SIMs registered in another person's name: ${person.localSims.map(s=>`${esc(s.msisdn)} (reg. ${esc(s.registeredName)})`).join('; ')}.`:''} ${person.imeis?.length>1?`Handset swap: ${person.imeis.map(esc).join(' → ')}.`:''}</div>`:''}`:'';
      const selRows=pv.selectors.filter(s=>s.hop>0).slice(0,80);
      body=`${head}<div class="inv-hint" style="font-size:9.5px">Breadth-first pivot over shared identifiers (H0 = matched a start selector, H1+ = reached through a selector found on an earlier record). Common values (hotel addresses, company cardholders) are shown but not expanded. Click any value to pivot from it.</div>${chips}${answer}
        <div class="pd-sub-h">Derived selectors (${selRows.length})</div><div class="pd-chips">${selRows.map(s=>`<span class="pd-chip" style="border-color:rgba(68,204,255,0.3);color:var(--text)"><span class="pd-hop h${s.hop}">H${s.hop}</span>${esc(s.t)} ${sel(s.t,s.v,String(s.v).slice(0,36))}${s.common?' <span style="color:var(--dim)">(common)</span>':''}</span>`).join('')}</div>
        ${groups.map(g=>`<div class="pd-sub-h">${esc(DSL[g.k])} — ${g.rows.length?`${g.rows.length} linked`:'<span style="color:var(--dim)">not found</span>'}</div>${g.rows.length?recTable(g.k,g.rows,true):''}`).join('')}`;
    }
    return `<div class="g-panel lp-wide"><div class="sec-head"><h3>Person / Selector Dossier</h3><span class="badge" style="color:#ff4081;border-color:rgba(255,64,129,0.5)">SYNTHETIC</span></div>
      <div class="pd-banner">Fictional person and fictional records — generated scenario data, not real individuals.</div>
      <div class="pd-tools"><button class="inv-btn" data-pd="clearpivot">Close</button>${person?'<button class="inv-btn" data-pd="fitpoi">Zoom map to track</button>':''}</div>${body}</div>`;
  }

  function explorerPanel(){
    if(!PD.syn)return '';
    const syn=PD.data?.synthetic;if(!syn)return '';
    const q=PD.q.trim().toLowerCase();
    const all=syn.datasets[PD.ds]||[];
    const rows=(q?all.filter(r=>JSON.stringify(r).toLowerCase().includes(q)):all);
    return `<div class="g-panel lp-wide"><div class="sec-head"><h3>Synthetic Data Explorer</h3><span class="badge" style="color:#ff4081;border-color:rgba(255,64,129,0.5)">SYNTHETIC · ${syn.persons.length} PERSONS</span></div>
      <div class="pd-banner">${esc(syn.notice)}</div>
      <div class="pd-tabs">${DS.map(k=>`<button class="inv-btn${PD.ds===k?' active':''}" data-ds="${k}">${esc(syn.labels?.[k]||k)} · ${syn.counts[k]}</button>`).join('')}</div>
      <div class="pd-tools"><input class="inv-input" id="pdQ" placeholder="Filter ${esc(DSL[PD.ds])} records (name, number, city, plate…)" value="${esc(PD.q)}" style="flex:1;margin:0"><span class="inv-hint">${rows.length} / ${all.length}${rows.length>300?' · first 300':''}</span></div>
      ${recTable(PD.ds,rows.slice(0,300).map(rec=>({rec})),false)}</div>`;
  }

  function stopsPanel(){
    const dels=visDel();
    const rows=dels.flatMap(d=>d.stops.map(s=>({d,s}))).sort((a,b)=>b.s.date.localeCompare(a.s.date));
    return `<div class="g-panel lp-wide"><div class="sec-head"><h3>Stops &amp; Concurrent Events</h3><span class="badge">${rows.length} STOPS</span></div>
      <div class="pd-scroll" style="max-height:360px"><table class="pd-tbl"><thead><tr><th>Date</th><th>Delegation</th><th>Stop</th><th>Reported meetings</th><th>Concurrent PRC-linked events (±${PD.data?.windowDays??3} d)</th><th>Source</th></tr></thead><tbody>
      ${rows.map(({d,s})=>`<tr class="${d.synthetic?'hl':''}"><td class="m">${esc(s.date)}</td><td><span class="pd-dot" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;background:${colorOf(d)}"></span>${esc(d.label)}${d.synthetic?'<span class="pd-syn">SYN</span>':''}</td>
        <td><span class="pd-sel" data-stop="${esc(s.id)}" data-del="${esc(d.id)}">#${s.seq} ${esc(s.city)}</span><br><span style="color:var(--dim)">${esc(s.country)}</span></td><td>${(s.meetings||[]).map(esc).join('<br>')||'<span style="color:var(--dim)">—</span>'}</td>
        <td>${concHtml(s)||'<span style="color:var(--dim)">—</span>'}</td><td>${(s.sources||[]).slice(0,2).map(x=>x.url?`<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent2)">${esc(x.outlet||'link')}</a>`:esc(x.outlet||'')).join('<br>')}${s.sources?.length>2?`<br><span style="color:var(--dim)">+${s.sources.length-2}</span>`:''}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }

  function editorPanel(){
    if(!PD.editor)return '';
    const sc=PD.scenario;
    return `<div class="g-panel lp-wide"><div class="sec-head"><h3>Synthetic Scenario</h3><span class="badge">${sc?.custom?'CUSTOM':'DEFAULT'}</span></div>
      <div class="inv-hint" style="font-size:9.5px">Edit the scenario JSON (seed, coverage probabilities, scenario delegations / stops / meetings, scenario events). Saved to this app's own persistent volume; "Reset" returns to the shipped default.</div>
      <textarea class="pd-ta" id="pdScenario" spellcheck="false">${esc(sc?JSON.stringify(sc.scenario,null,2):'Loading…')}</textarea>
      <div class="pd-tools" style="margin-top:6px"><button class="inv-btn" data-pd="savesc">Save &amp; regenerate</button><button class="inv-btn" data-pd="resetsc">Reset to default</button><button class="inv-btn" data-pd="editor">Close</button></div>
      ${PD.scErr?`<div class="pd-err">${esc(PD.scErr)}</div>`:''}</div>`;
  }

  // ── Wiring into the shared renderers ───────────────────────────────────────
  const _tc=tabCounts;
  tabCounts=function(){let c;try{c=_tc()}catch{c={}}const d=PD.data;c.prcdel=d?{n:String(d.counts.overlaps||d.counts.delegations),cls:d.counts.overlaps?'hot':'',title:`${d.counts.delegations} delegations · ${d.counts.overlaps} concurrent PRC-linked events`}:null;return c};
  const _rl=renderLeftRail;
  renderLeftRail=function(){
    if(!active())return _rl();
    const rail=document.getElementById('leftRail');
    rail.innerHTML=controlsPanel()+poiPanel();
    if(typeof applyCaptions==='function')applyCaptions(rail);
  };
  const _rlow=renderLower;
  renderLower=function(){
    if(!active())return _rlow();
    const grid=document.getElementById('lowerGrid');
    if(!PD.data&&!PD.loading)load();
    if(!PD.data){grid.innerHTML=`<div class="g-panel lp-wide"><div class="sec-head"><h3>Delegation Travel Map</h3></div><div class="inv-hint">${PD.err?esc(PD.err):'Collecting delegation reporting (first load can take ~20 s)…'}</div></div>`;return}
    grid.innerHTML=editorPanel()+mapPanel()+dossierPanel()+stopsPanel()+explorerPanel();
    if(typeof applyCaptions==='function')applyCaptions(grid);
    requestAnimationFrame(()=>{initMap();const pop=document.getElementById('pdPop');if(pop)placePop(pop)});
  };

  document.addEventListener('change',e=>{
    if(!active())return;
    const id=e.target.id;
    if(id==='pdWin'){PD.win=+e.target.value;PD.pop=null;load()}
    else if(id==='pdSyn'){PD.syn=e.target.checked;localStorage.setItem('pd_syn',PD.syn?'1':'0');PD.pop=null;if(!PD.syn){PD.pivotFor=null;PD.pivot=null;if(PD.sel?.type==='person')PD.sel=null}load()}
    else if(id==='pdTracks'){PD.tracks=e.target.checked;renderLower()}
    else if(id==='pdAnswer'){PD.answer=e.target.checked;renderLower()}
  });
  let qT=null;
  document.addEventListener('input',e=>{
    if(!active()||e.target.id!=='pdQ')return;
    PD.q=e.target.value;clearTimeout(qT);
    qT=setTimeout(()=>{const pos=e.target.selectionStart;renderLower();const el=document.getElementById('pdQ');if(el){el.focus();el.setSelectionRange(pos,pos)}},250);
  });
  document.addEventListener('click',async e=>{
    if(!active())return;
    const t=e.target.closest('[data-pd],[data-del],[data-eye],[data-person],[data-ds],.pd-sel');if(!t)return;
    if(t.dataset.eye){e.stopPropagation();const id=t.dataset.eye;PD.hidden.has(id)?PD.hidden.delete(id):PD.hidden.add(id);PD.transform=null;renderLeftRail();renderLower();return}
    if(t.dataset.person){selectPerson(t.dataset.person);PD.transform=null;renderLeftRail();return}
    if(t.dataset.stop){const d=PD.data.delegations.find(x=>x.id===t.dataset.del);const s=d?.stops.find(x=>x.id===t.dataset.stop);if(s){PD.hidden.delete(d.id);PD.transform=null;renderLower();requestAnimationFrame(()=>{const xy=proj&&proj([s.lon,s.lat]);if(xy){PD.pop={type:'stop',del:d.id,id:s.id,x:xy[0],y:xy[1]};renderLower();document.getElementById('pdMapWrap')?.scrollIntoView({behavior:'smooth',block:'center'})}})}return}
    if(t.classList.contains('pd-sel')&&t.dataset.t){PD.sel={type:'selector'};PD.pop=null;loadPivot({t:t.dataset.t,v:t.dataset.v},`${t.dataset.t}: ${t.dataset.v}`);renderLeftRail();return}
    if(t.dataset.ds){PD.ds=t.dataset.ds;renderLower();return}
    if(t.dataset.del&&!t.dataset.pd){PD.sel={type:'del',id:t.dataset.del};PD.hidden=new Set((PD.data.delegations||[]).filter(x=>x.id!==t.dataset.del).map(x=>x.id));PD.transform=null;PD.pop=null;renderLeftRail();renderLower();return}
    const a=t.dataset.pd;
    if(a==='refresh')load(true);
    else if(a==='all'){PD.hidden.clear();PD.sel=PD.sel?.type==='del'?null:PD.sel;PD.transform=null;renderLeftRail();renderLower()}
    else if(a==='none'){PD.hidden=new Set((PD.data?.delegations||[]).map(x=>x.id));renderLeftRail();renderLower()}
    else if(a==='closepop'){e.stopPropagation();PD.pop=null;renderLower()}
    else if(a==='clearpivot'){PD.pivotFor=null;PD.pivot=null;if(PD.sel?.type!=='del')PD.sel=null;PD.transform=null;renderLeftRail();renderLower()}
    else if(a==='fitpoi'){PD.transform=null;renderLower();document.getElementById('pdMapWrap')?.scrollIntoView({behavior:'smooth',block:'center'})}
    else if(a==='editor'){PD.editor=!PD.editor;if(PD.editor){PD.scErr=null;const r=await fetch('/api/prcdel/scenario');PD.scenario=await r.json()}renderLower()}
    else if(a==='savesc'){
      let body;try{body=JSON.parse(document.getElementById('pdScenario').value)}catch(err){PD.scErr='Invalid JSON: '+err.message;renderLower();return}
      const r=await fetch('/api/prcdel/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();
      if(!r.ok){PD.scErr=j.error;renderLower();return}
      PD.scErr=null;PD.scenario={custom:true,scenario:body};PD.pivotFor=null;PD.pivot=null;PD.sel=null;await load();
    }
    else if(a==='resetsc'){await fetch('/api/prcdel/scenario',{method:'DELETE'});const r=await fetch('/api/prcdel/scenario');PD.scenario=await r.json();PD.scErr=null;PD.pivotFor=null;PD.pivot=null;PD.sel=null;await load()}
  });

  // PRC WATCH chip → this tab
  // The top bar is re-rendered on every sweep, so mark + handle the chip by delegation, not a one-time binding.
  const isPrcChip=el=>el&&/PRC WATCH/.test(el.textContent);
  const markChip=()=>document.querySelectorAll('.regime-chip').forEach(el=>{if(isPrcChip(el)&&!el.classList.contains('pd-link')){el.classList.add('pd-link');el.title='Open the Chinese Delegation Tracker'}});
  document.addEventListener('click',e=>{const c=e.target.closest('.regime-chip');if(isPrcChip(c)){e.preventDefault();setTab('prcdel')}});
  new MutationObserver(markChip).observe(document.body,{childList:true,subtree:true});
  markChip();
  if(active()&&typeof D!=='undefined'&&D){renderTabbar();renderLeftRail();renderLower()}
})();
