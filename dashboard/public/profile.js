// Deployment profile (window.__CRUCIX_PROFILE__, injected by server.mjs from lib/profile.mjs):
// trims the tab bar, relabels tabs and opens the map on the profile's region.
(function(){
  const P=window.__CRUCIX_PROFILE__;
  if(!P||typeof TAB_DEFS==='undefined')return;
  if(Array.isArray(P.tabs)){
    const keep=TAB_DEFS.filter(t=>P.tabs.includes(t.id)).sort((a,b)=>P.tabs.indexOf(a.id)-P.tabs.indexOf(b.id));
    TAB_DEFS.splice(0,TAB_DEFS.length,...keep);
    TAB_IDS.splice(0,TAB_IDS.length,...keep.map(t=>t.id));
  }
  for(const t of TAB_DEFS){
    if(P.tabLabels&&P.tabLabels[t.id])t.label=P.tabLabels[t.id];
    if(P.tabHints&&P.tabHints[t.id])t.hint=P.tabHints[t.id];
  }
  for(const [to,from] of Object.entries(P.mergeTabs||{}))for(const f of from||[])if(TAB_IDS.includes(to)&&!TAB_IDS.includes(f))TAB_ALIASES[f]=to;
  if(!TAB_IDS.includes(currentTab)){currentTab=resolveTab(currentTab)||'situation';syncHash(currentTab)}
  window.addEventListener('hashchange',()=>{if(!tabFromHash()&&typeof setTab==='function')setTab('situation')});
  if(P.title)document.title='CRUCIX \u00b7 '+P.title;
  if(P.region){
    currentRegion=P.region;
    let tries=0;
    const t=setInterval(()=>{
      tries++;
      if(typeof flatZoom!=='undefined'&&flatZoom&&typeof flatSvg!=='undefined'&&flatSvg){clearInterval(t);setTimeout(()=>{try{setRegion(P.region)}catch{}},300)}
      else if(tries>120)clearInterval(t);
    },250);
  }
  if(typeof D!=='undefined'&&D){try{renderTopbar();renderTabbar();renderLeftRail();renderLower()}catch{}}
})();
