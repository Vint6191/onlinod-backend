
(function () {
  "use strict";
  const h = () => window.OnlinodRouter.escapeHtml;
  const a = () => window.OnlinodRouter.escapeAttr;
  const api = () => window.OnlinodAdminAuth;
  const TIERS = { STARTER: { price: 2000, revenue: "$0–$1k" }, GROWTH: { price: 3000, revenue: "$1k–$5k" }, PRO: { price: 5000, revenue: "$5k–$15k" }, ELITE: { price: 15000, revenue: "$15k+" }, CUSTOM: { price: 0, revenue: "manual" } };
  const state = { agencies: [], selectedAgencyId: null, selectedAgency: null, liveFeed: [], error: null, expandedCreatorId: null };

  function money(cents){ return `$${(Number(cents || 0) / 100).toFixed(0)}`; }
  function dateShort(value){ if(!value) return "—"; try { return new Date(value).toLocaleString(); } catch(_) { return String(value); } }
  function healthBadge(health){ const level=health?.level||"unknown"; const score=health?.score??0; return `<span class="admin-health ${a()(level)}">${h()(level)} · ${h()(score)}</span>`; }
  function creatorKind(c){ if(c.partition==="persist:acct_demo") return "TEST"; if(c.status==="NOT_CREATOR") return "NOT_CREATOR"; if(c.status==="READY"&&c.remoteId) return "REAL"; if(c.status==="READY"&&c.username&&!c.remoteId) return "DUPLICATE?"; return c.status||"UNKNOWN"; }
  function cls(v){ return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g,"-"); }

  function localHealth(agency){
    const creators=agency?.creators||[], snaps=agency?.accessSnapshots||[];
    const active=new Set(snaps.filter(x=>x.active&&!x.revokedAt).map(x=>x.creatorId));
    let score=100; const issues=[];
    for(const c of creators){
      if(c.status==="READY"&&!active.has(c.id)){score-=18;issues.push({severity:"ERROR",message:`${c.displayName} is READY but has no active snapshot`});}
      if(c.status==="NOT_CREATOR"){score-=6;issues.push({severity:"WARNING",message:`${c.displayName} is NOT_CREATOR`});}
      if(c.status==="READY"&&c.username&&!c.remoteId){score-=8;issues.push({severity:"WARNING",message:`${c.displayName} has username but no remoteId — possible duplicate`});}
      if(c.partition==="persist:acct_demo"){score-=10;issues.push({severity:"WARNING",message:`${c.displayName} uses persist:acct_demo — likely test duplicate`});}
    }
    score=Math.max(0,Math.min(100,score));
    return { score, level: score>=80?"healthy":score>=55?"warning":"critical", issues };
  }

  async function loadAgencies(){ const d=await api().request("/api/admin/agencies"); if(!d.ok) throw new Error(d.error||"Failed to load agencies"); state.agencies=d.agencies||[]; if(!state.selectedAgencyId&&state.agencies[0]) state.selectedAgencyId=state.agencies[0].id; }
  async function loadAgency(id){ if(!id)return; const d=await api().request(`/api/admin/agencies/${encodeURIComponent(id)}`); if(!d.ok) throw new Error(d.error||"Failed to load agency"); state.selectedAgency=d.agency; }
  async function loadLiveFeed(){ const q=state.selectedAgencyId?`?agencyId=${encodeURIComponent(state.selectedAgencyId)}`:""; const d=await api().request(`/api/admin/live-feed${q}`); if(d.ok) state.liveFeed=d.events||[]; }
  async function bootstrap(){ try { await loadAgencies(); await loadAgency(state.selectedAgencyId); await loadLiveFeed(); } catch(e) { state.error=e.message||String(e); } }

  function renderPlans(){
    return `<section class="admin-card"><div class="admin-card-head"><strong>Plans / Creator tiers</strong><span class="admin-muted">Core scales by creator revenue</span></div>
      <div class="admin-plan-grid">${Object.entries(TIERS).map(([k,t])=>`<div class="admin-plan-card"><b>${h()(k)}</b><strong>${h()(money(t.price))}</strong><span>${h()(t.revenue)}</span></div>`).join("")}</div>
      <div class="admin-addon-row"><span>AI Chatter</span><b>$100 / creator / month</b></div>
      <div class="admin-addon-row"><span>SFS + Comment Bot</span><b>$29 / creator / month</b></div>
    </section>`;
  }

  function renderBilling(agency){
    return `<section class="admin-card"><div class="admin-card-head"><strong>Billing override</strong></div><div class="admin-grid-2">
      <label class="on-field"><span>Plan</span><input class="on-input" id="adminPlan" value="${a()(agency.plan||"trial")}"></label>
      <label class="on-field"><span>Status</span><select class="on-input" id="adminStatus">${["TRIAL","ACTIVE","PAST_DUE","GRACE","CANCELLED","LOCKED"].map(x=>`<option value="${x}" ${String(agency.status)===x?"selected":""}>${x}</option>`).join("")}</select></label>
      <label class="on-field"><span>Default core price cents</span><input class="on-input" type="number" id="adminCorePrice" value="${a()(agency.subscriptions?.[0]?.corePricePerCreatorCents||2000)}"></label>
      <label class="on-field"><span>Period end ISO</span><input class="on-input" id="adminPeriodEnd" value="${a()(agency.currentPeriodEnd||agency.subscriptions?.[0]?.currentPeriodEnd||"")}"></label>
    </div><label class="on-field"><span>Reason</span><input class="on-input" id="adminBillingReason" placeholder="manual support change"></label><button class="on-btn primary" id="adminSaveBilling">Save billing</button></section>`;
  }

  function renderHealth(health){
    return `<section class="admin-card"><div class="admin-card-head"><strong>Health</strong>${healthBadge(health)}</div><div class="admin-healthbar"><i style="width:${health.score}%"></i></div><div class="admin-issues">${health.issues.map(i=>`<div class="admin-issue ${a()(i.severity)}"><b>${h()(i.severity)}</b><span>${h()(i.message)}</span></div>`).join("")||`<div class="admin-empty">No issues</div>`}</div></section>`;
  }

  function renderDebug(c){
    return `<div class="admin-creator-debug">
      <div><b>ID</b><code>${h()(c.id)}</code></div><div><b>remoteId</b><code>${h()(c.remoteId||"null")}</code></div><div><b>username</b><code>${h()(c.username||"null")}</code></div>
      <div><b>partition</b><code>${h()(c.partition||"null")}</code></div><div><b>created</b><code>${h()(dateShort(c.createdAt))}</code></div><div><b>updated</b><code>${h()(dateShort(c.updatedAt))}</code></div>
    </div>`;
  }

  function renderBillingControls(c){
    const b=c.billingProfile||{}, current=b.tier||"STARTER";
    return `<div class="admin-creator-billing">
      <label><span>Tier</span><select class="on-input admin-creator-tier" data-creator-tier="${a()(c.id)}">${Object.keys(TIERS).map(x=>`<option value="${x}" ${current===x?"selected":""}>${x} · ${money(TIERS[x].price)}</option>`).join("")}</select></label>
      <label><span>Core cents</span><input class="on-input" type="number" data-creator-price="${a()(c.id)}" value="${a()(b.corePriceCents||TIERS[current]?.price||2000)}"></label>
      <label class="admin-check"><input type="checkbox" data-creator-ai="${a()(c.id)}" ${b.aiChatterEnabled?"checked":""}><span>AI</span></label>
      <label class="admin-check"><input type="checkbox" data-creator-outreach="${a()(c.id)}" ${b.outreachEnabled?"checked":""}><span>SFS</span></label>
      <label class="admin-check"><input type="checkbox" data-creator-excluded="${a()(c.id)}" ${b.billingExcluded?"checked":""}><span>excluded</span></label>
      <button class="on-btn" data-save-creator-billing="${a()(c.id)}">save plan</button>
    </div>`;
  }

  function renderCreators(agency){
    const creators=agency.creators||[];
    return `<section class="admin-card"><div class="admin-card-head"><strong>Creators</strong><span>${creators.length}</span></div><div class="admin-creator-list">${creators.map(c=>{
      const kind=creatorKind(c), expanded=state.expandedCreatorId===c.id, b=c.billingProfile||{};
      return `<div class="admin-creator-row ${a()(cls(kind))}"><div class="admin-creator-main">
        <div><b>${h()(c.displayName)}</b><em>${h()(c.username?"@"+c.username:c.remoteId||c.partition||"")}</em></div>
        <span class="admin-pill ${a()(cls(kind))}">${h()(kind)}</span><span>${h()(c.status)}</span>
        <span><b>${h()(c.remoteId||"no remoteId")}</b><em>${h()(c.partition||"no partition")}</em></span>
        <span>${h()(c.accessSnapshots?.filter(x=>x.active&&!x.revokedAt).length||0)} active</span>
        <span>${h()(b.tier||"STARTER")} · ${h()(money(b.corePriceCents||2000))}</span>
        <span class="admin-actions"><button class="on-btn" data-toggle-creator="${a()(c.id)}">${expanded?"hide":"inspect"}</button><button class="on-btn" data-admin-creator-status="${a()(c.id)}" data-status="READY">ready</button><button class="on-btn" data-admin-creator-status="${a()(c.id)}" data-status="DISABLED">disable</button><button class="on-btn danger" data-admin-delete-creator="${a()(c.id)}">delete</button></span>
      </div>${expanded?`${renderDebug(c)}${renderBillingControls(c)}`:""}</div>`;
    }).join("")}</div></section>`;
  }

  function renderLiveFeed(){
    return `<section class="admin-card"><div class="admin-card-head"><strong>Live log</strong></div><div class="admin-feed">${state.liveFeed.map(e=>`<div class="admin-feed-row"><time>${h()(dateShort(e.createdAt))}</time><b>${h()(e.action)}</b><span>${h()(e.actorUserId||"admin")}</span><small>${h()(e.targetType||"")} ${h()(e.targetId||"")}</small></div>`).join("")||`<div class="admin-empty">No events yet</div>`}</div></section>`;
  }

  function render(root){
    const agency=state.selectedAgency, health=localHealth(agency);
    root.innerHTML=`<main class="admin-shell"><header class="admin-top"><div><strong>Onlinod Internal Admin</strong><span>billing · creator plans · health · cleanup · live log</span></div><div class="admin-top-actions"><button class="on-btn" id="adminLogout">logout</button><button class="on-btn" id="adminRefresh">refresh</button></div></header>
      ${state.error?`<div class="admin-error">${h()(state.error)}</div>`:""}<div class="admin-layout"><section class="admin-card"><div class="admin-card-head"><strong>Agencies</strong></div><div class="admin-agency-list">${state.agencies.map(ag=>`<button class="admin-agency-row ${ag.id===state.selectedAgencyId?"active":""}" data-admin-agency="${a()(ag.id)}"><span><b>${h()(ag.name)}</b><em>${h()(ag.owner?.email||"no owner")}</em></span>${healthBadge(ag.health)}<small>${h()(ag.status||"—")} · ${h()(ag.counts?.creators||0)} creators</small></button>`).join("")}</div></section>
      <div class="admin-main">${agency?`<section class="admin-card admin-hero"><div><strong>${h()(agency.name)}</strong><span>${h()(agency.id)}</span></div>${healthBadge(health)}</section>${renderPlans()}${renderBilling(agency)}${renderHealth(health)}${renderCreators(agency)}${renderLiveFeed()}`:`<section class="admin-card"><div class="admin-empty">Select agency</div></section>`}</div></div></main>`;
    bind(root);
  }

  async function reload(root){ await bootstrap(); render(root); }
  function q(root,sel){ return root.querySelector(sel); }

  function bind(root){
    q(root,"#adminLogout")?.addEventListener("click",()=>window.OnlinodAdminAuth.logout());
    q(root,"#adminRefresh")?.addEventListener("click",()=>reload(root));
    root.querySelectorAll("[data-admin-agency]").forEach(el=>el.addEventListener("click",async()=>{ state.selectedAgencyId=el.dataset.adminAgency; state.expandedCreatorId=null; await loadAgency(state.selectedAgencyId); await loadLiveFeed(); render(root); }));
    q(root,"#adminSaveBilling")?.addEventListener("click",async()=>{ const r=await api().request(`/api/admin/agencies/${encodeURIComponent(state.selectedAgencyId)}/subscription`,{method:"PATCH",body:{plan:q(root,"#adminPlan").value,status:q(root,"#adminStatus").value,corePricePerCreatorCents:Number(q(root,"#adminCorePrice").value||2000),currentPeriodEnd:q(root,"#adminPeriodEnd").value||null,reason:q(root,"#adminBillingReason").value||"manual admin change"}}); if(!r.ok)return window.OnlinodRouter.toast(r.error||"Save failed"); await reload(root); });
    root.querySelectorAll("[data-toggle-creator]").forEach(el=>el.addEventListener("click",()=>{ const id=el.dataset.toggleCreator; state.expandedCreatorId=state.expandedCreatorId===id?null:id; render(root); }));
    root.querySelectorAll(".admin-creator-tier").forEach(el=>el.addEventListener("change",()=>{ const id=el.dataset.creatorTier; const price=root.querySelector(`[data-creator-price="${CSS.escape(id)}"]`); if(price && TIERS[el.value] && el.value!=="CUSTOM") price.value=String(TIERS[el.value].price); }));
    root.querySelectorAll("[data-save-creator-billing]").forEach(el=>el.addEventListener("click",async()=>{ const id=el.dataset.saveCreatorBilling; const r=await api().request(`/api/admin/creators/${encodeURIComponent(id)}/billing`,{method:"PATCH",body:{tier:root.querySelector(`[data-creator-tier="${CSS.escape(id)}"]`)?.value||"STARTER",tierMode:"MANUAL",corePriceCents:Number(root.querySelector(`[data-creator-price="${CSS.escape(id)}"]`)?.value||2000),aiChatterEnabled:root.querySelector(`[data-creator-ai="${CSS.escape(id)}"]`)?.checked===true,outreachEnabled:root.querySelector(`[data-creator-outreach="${CSS.escape(id)}"]`)?.checked===true,billingExcluded:root.querySelector(`[data-creator-excluded="${CSS.escape(id)}"]`)?.checked===true,reason:"manual creator plan update"}}); if(!r.ok)return window.OnlinodRouter.toast(r.error||"Plan save failed"); await reload(root); }));
    root.querySelectorAll("[data-admin-creator-status]").forEach(el=>el.addEventListener("click",async()=>{ const r=await api().request(`/api/admin/creators/${encodeURIComponent(el.dataset.adminCreatorStatus)}/status`,{method:"PATCH",body:{status:el.dataset.status,reason:"manual admin status change"}}); if(!r.ok)return window.OnlinodRouter.toast(r.error||"Status failed"); await reload(root); }));
    root.querySelectorAll("[data-admin-delete-creator]").forEach(el=>el.addEventListener("click",async()=>{ const id=el.dataset.adminDeleteCreator; const c=(state.selectedAgency?.creators||[]).find(x=>x.id===id); const summary=c?`${c.displayName}\nremoteId: ${c.remoteId||"null"}\npartition: ${c.partition||"null"}\nid: ${c.id}`:id; if(!confirm(`Delete creator?\\n\\n${summary}`))return; const r=await api().request(`/api/admin/creators/${encodeURIComponent(id)}`,{method:"DELETE"}); if(!r.ok)return window.OnlinodRouter.toast(r.error||"Delete failed"); await reload(root); }));
  }

  async function start(root){ root.innerHTML=`<main class="admin-shell"><div class="admin-card">Loading admin…</div></main>`; await bootstrap(); render(root); }
  async function guardedStart(root){ const ok=await window.OnlinodAdminAuth.ensureAdminSession(root); if(!ok)return; await start(root); }
  window.OnlinodAdminPage={render:guardedStart};
})();
