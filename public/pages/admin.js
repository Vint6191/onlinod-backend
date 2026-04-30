(function () {
  "use strict";
  const h = () => window.OnlinodRouter.escapeHtml;
  const a = () => window.OnlinodRouter.escapeAttr;
  const api = () => window.OnlinodAdminAuth;
  const state = { agencies: [], selectedAgencyId: null, selectedAgency: null, liveFeed: [], error: null };

  function healthBadge(health){const level=health?.level||"unknown";const score=health?.score??0;return `<span class="admin-health ${a()(level)}">${h()(level)} · ${h()(score)}</span>`;}
  function localHealth(agency){const creators=agency?.creators||[];const snaps=agency?.accessSnapshots||[];const active=new Set(snaps.filter(x=>x.active&&!x.revokedAt).map(x=>x.creatorId));let score=100;const issues=[];for(const c of creators){if(c.status==="READY"&&!active.has(c.id)){score-=18;issues.push({severity:"ERROR",message:`${c.displayName} is READY but has no active snapshot`})}if(c.status==="NOT_CREATOR"){score-=6;issues.push({severity:"WARNING",message:`${c.displayName} is NOT_CREATOR`})}}score=Math.max(0,Math.min(100,score));return{score,level:score>=80?"healthy":score>=55?"warning":"critical",issues};}
  async function loadAgencies(){const d=await api().request("/api/admin/agencies");if(!d.ok)throw new Error(d.error||"Failed to load agencies");state.agencies=d.agencies||[];if(!state.selectedAgencyId&&state.agencies[0])state.selectedAgencyId=state.agencies[0].id;}
  async function loadAgency(id){if(!id)return;const d=await api().request(`/api/admin/agencies/${encodeURIComponent(id)}`);if(!d.ok)throw new Error(d.error||"Failed to load agency");state.selectedAgency=d.agency;}
  async function loadLiveFeed(){const q=state.selectedAgencyId?`?agencyId=${encodeURIComponent(state.selectedAgencyId)}`:"";const d=await api().request(`/api/admin/live-feed${q}`);if(d.ok)state.liveFeed=d.events||[];}
  async function bootstrap(){try{await loadAgencies();await loadAgency(state.selectedAgencyId);await loadLiveFeed();}catch(e){state.error=e.message||String(e);}}

  function render(root){
    const agency=state.selectedAgency, health=localHealth(agency);
    root.innerHTML=`<main class="admin-shell">
      <header class="admin-top"><div><strong>Onlinod Internal Admin</strong><span>billing · health · cleanup · live log</span></div><div class="admin-top-actions"><button class="on-btn" id="adminLogout">logout</button><button class="on-btn" id="adminRefresh">refresh</button></div></header>
      ${state.error?`<div class="admin-error">${h()(state.error)}</div>`:""}
      <div class="admin-layout">
        <section class="admin-card"><div class="admin-card-head"><strong>Agencies</strong></div><div class="admin-agency-list">${state.agencies.map(ag=>`<button class="admin-agency-row ${ag.id===state.selectedAgencyId?"active":""}" data-admin-agency="${a()(ag.id)}"><span><b>${h()(ag.name)}</b><em>${h()(ag.owner?.email||"no owner")}</em></span>${healthBadge(ag.health)}<small>${h()(ag.status||"—")} · ${h()(ag.counts?.creators||0)} creators</small></button>`).join("")}</div></section>
        <div class="admin-main">${agency?`
          <section class="admin-card admin-hero"><div><strong>${h()(agency.name)}</strong><span>${h()(agency.id)}</span></div>${healthBadge(health)}</section>
          <section class="admin-card"><div class="admin-card-head"><strong>Billing override</strong></div><div class="admin-grid-2">
            <label class="on-field"><span>Plan</span><input class="on-input" id="adminPlan" value="${a()(agency.plan||"trial")}"></label>
            <label class="on-field"><span>Status</span><select class="on-input" id="adminStatus">${["TRIAL","ACTIVE","PAST_DUE","GRACE","CANCELLED","LOCKED"].map(x=>`<option value="${x}" ${String(agency.status)===x?"selected":""}>${x}</option>`).join("")}</select></label>
            <label class="on-field"><span>Core price cents</span><input class="on-input" type="number" id="adminCorePrice" value="${a()(agency.subscriptions?.[0]?.corePricePerCreatorCents||2000)}"></label>
            <label class="on-field"><span>Period end ISO</span><input class="on-input" id="adminPeriodEnd" value="${a()(agency.currentPeriodEnd||agency.subscriptions?.[0]?.currentPeriodEnd||"")}"></label>
          </div><label class="on-field"><span>Reason</span><input class="on-input" id="adminBillingReason" placeholder="manual support change"></label><button class="on-btn primary" id="adminSaveBilling">Save billing</button></section>
          <section class="admin-card"><div class="admin-card-head"><strong>Health</strong>${healthBadge(health)}</div><div class="admin-healthbar"><i style="width:${health.score}%"></i></div><div class="admin-issues">${health.issues.map(i=>`<div class="admin-issue ${a()(i.severity)}"><b>${h()(i.severity)}</b><span>${h()(i.message)}</span></div>`).join("")||`<div class="admin-empty">No issues</div>`}</div></section>
          <section class="admin-card"><div class="admin-card-head"><strong>Creators</strong><span>${(agency.creators||[]).length}</span></div><div class="admin-table"><div class="admin-table-row head"><span>Name</span><span>Status</span><span>Snapshots</span><span>Actions</span></div>${(agency.creators||[]).map(c=>`<div class="admin-table-row"><span><b>${h()(c.displayName)}</b><em>${h()(c.username?"@"+c.username:c.remoteId||c.partition||"")}</em></span><span>${h()(c.status)}</span><span>${h()(c.accessSnapshots?.filter(x=>x.active&&!x.revokedAt).length||0)} active</span><span class="admin-actions"><button class="on-btn" data-admin-creator-status="${a()(c.id)}" data-status="READY">ready</button><button class="on-btn" data-admin-creator-status="${a()(c.id)}" data-status="DISABLED">disable</button><button class="on-btn danger" data-admin-delete-creator="${a()(c.id)}">delete</button></span></div>`).join("")}</div></section>
          <section class="admin-card"><div class="admin-card-head"><strong>Live log</strong></div><div class="admin-feed">${state.liveFeed.map(e=>`<div class="admin-feed-row"><time>${h()(new Date(e.createdAt).toLocaleString())}</time><b>${h()(e.action)}</b><span>${h()(e.actorUserId||"admin")}</span><small>${h()(e.targetType||"")} ${h()(e.targetId||"")}</small></div>`).join("")||`<div class="admin-empty">No events yet</div>`}</div></section>`:`<section class="admin-card"><div class="admin-empty">Select agency</div></section>`}</div>
      </div></main>`;
    bind(root);
  }

  async function reload(root){await bootstrap();render(root);}
  function bind(root){
    root.querySelector("#adminLogout")?.addEventListener("click",()=>window.OnlinodAdminAuth.logout());
    root.querySelector("#adminRefresh")?.addEventListener("click",()=>reload(root));
    root.querySelectorAll("[data-admin-agency]").forEach(el=>el.addEventListener("click",async()=>{state.selectedAgencyId=el.dataset.adminAgency;await loadAgency(state.selectedAgencyId);await loadLiveFeed();render(root);}));
    root.querySelector("#adminSaveBilling")?.addEventListener("click",async()=>{const r=await api().request(`/api/admin/agencies/${encodeURIComponent(state.selectedAgencyId)}/subscription`,{method:"PATCH",body:{plan:root.querySelector("#adminPlan").value,status:root.querySelector("#adminStatus").value,corePricePerCreatorCents:Number(root.querySelector("#adminCorePrice").value||2000),currentPeriodEnd:root.querySelector("#adminPeriodEnd").value||null,reason:root.querySelector("#adminBillingReason").value||"manual admin change"}});if(!r.ok)return window.OnlinodRouter.toast(r.error||"Save failed");window.OnlinodRouter.toast("Billing saved");await reload(root);});
    root.querySelectorAll("[data-admin-creator-status]").forEach(el=>el.addEventListener("click",async()=>{const r=await api().request(`/api/admin/creators/${encodeURIComponent(el.dataset.adminCreatorStatus)}/status`,{method:"PATCH",body:{status:el.dataset.status,reason:"manual admin status change"}});if(!r.ok)return window.OnlinodRouter.toast(r.error||"Status failed");await reload(root);}));
    root.querySelectorAll("[data-admin-delete-creator]").forEach(el=>el.addEventListener("click",async()=>{if(!confirm("Delete creator?"))return;const r=await api().request(`/api/admin/creators/${encodeURIComponent(el.dataset.adminDeleteCreator)}`,{method:"DELETE"});if(!r.ok)return window.OnlinodRouter.toast(r.error||"Delete failed");await reload(root);}));
  }
  async function start(root){root.innerHTML=`<main class="admin-shell"><div class="admin-card">Loading admin…</div></main>`;await bootstrap();render(root);}
  async function guardedStart(root){const ok=await window.OnlinodAdminAuth.ensureAdminSession(root);if(!ok)return;await start(root);}
  window.OnlinodAdminPage={render:guardedStart};
})();
