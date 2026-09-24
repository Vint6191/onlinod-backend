(function () {
  "use strict";
  let opening=false;
  async function open(agencyId) {
    if(opening || document.getElementById("admSupportDialog")) return;
    const reason=prompt("Reason for opening agency support diagnostics (required):")?.trim();
    if(!reason) return;
    const requestedToken=window.OnlinodAdminApi.getToken();
    opening=true;
    let result;
    try { result=await window.OnlinodAdminApi.openSupport({agencyId,reason,durationMinutes:15}); }
    finally { opening=false; }
    if(window.OnlinodAdminApi.getToken()!==requestedToken){window.OnlinodAdminRouter.toast("Admin session changed. Reopen support.");return;}
    if(!result?.ok){window.OnlinodAdminRouter.toast(result?.error||"Support could not be opened");return;}
    const grant=result.grant;
    const openedToken=window.OnlinodAdminApi.getToken();
    const dialog=document.createElement("dialog");
    dialog.id="admSupportDialog";
    dialog.style.cssText="width:min(1100px,92vw);max-height:88vh;overflow:auto;background:var(--adm-bg,#171b24);color:inherit;border:1px solid #566070;border-radius:12px;padding:24px";
    dialog.innerHTML=`<h2>Agency support</h2><p>Diagnostic access under your administrator account. Changes are made through the agency actions.</p><p id="admSupportScope"></p><div id="admSupportContent" aria-live="polite"></div><div style="display:flex;gap:12px;margin-top:16px"><button class="adm-btn" id="admSupportPrevious">Previous</button><button class="adm-btn" id="admSupportNext">Next</button><button class="adm-btn" id="admSupportRefresh">Refresh</button><button class="adm-btn" id="admSupportEnd">End support</button></div>`;
    document.body.appendChild(dialog);dialog.showModal();
    const body=dialog.querySelector("#admSupportContent"),scope=dialog.querySelector("#admSupportScope");
    const previous=dialog.querySelector("#admSupportPrevious"),next=dialog.querySelector("#admSupportNext"),refresh=dialog.querySelector("#admSupportRefresh"),end=dialog.querySelector("#admSupportEnd");
    const escape=window.OnlinodAdminRouter.escapeHtml;
    let generation=0,cursor=null,nextCursor=null,history=[],closed=false,expiryTimer;
    function clear(message){generation++;body.textContent=message;next.disabled=previous.disabled=refresh.disabled=true;}
    function dispose(){closed=true;generation++;clearTimeout(expiryTimer);body.textContent="";dialog.close();dialog.remove();window.removeEventListener("onlinod:admin-session-changed",dispose);window.removeEventListener("storage",sessionChanged);}
    function sessionChanged(){if(window.OnlinodAdminApi.getToken()!==openedToken)dispose();}
    window.addEventListener("onlinod:admin-session-changed",dispose);
    window.addEventListener("storage",sessionChanged);
    async function load(){
      const current=++generation;
      const started=performance.now();
      body.textContent="Loading current agency diagnostics…";
      next.disabled=previous.disabled=refresh.disabled=true;
      const response=await window.OnlinodAdminApi.readSupport(grant.id,{cursor,limit:50});
      if(closed||current!==generation)return;
      if(window.OnlinodAdminApi.getToken()!==openedToken){dispose();return;}
      if(!response?.ok){clear(response?.error||"Support access is unavailable");return;}
      if(response.grant.id!==grant.id||response.agency.id!==agencyId){clear("Agency context changed. End support and reopen it.");return;}
      clearTimeout(expiryTimer);
      const remaining=new Date(response.grant.expiresAt).getTime()-new Date(response.authorityNow).getTime()-(performance.now()-started);
      if(remaining<=0){clear("Support access expired. End support and reopen it.");return;}
      expiryTimer=setTimeout(()=>clear("Support access expired. End support and reopen it."),remaining);
      scope.textContent=`${response.agency.name} · ${response.agency.id} · Expires ${new Date(response.grant.expiresAt).toLocaleTimeString()}`;
      body.innerHTML=`<p>Agency: ${escape(response.agency.status)} · Plan: ${escape(response.agency.plan||"—")}</p><table class="adm-table"><thead><tr><th>Model</th><th>ID</th><th>Status</th><th>Session</th><th>Retired</th></tr></thead><tbody>${response.creators.map(c=>`<tr><td>${escape(c.displayName)}</td><td>${escape(c.id)}</td><td>${escape(c.status)}</td><td>${escape(c.sessionState?.status||"—")}</td><td>${c.deletedAt?"Yes":"No"}</td></tr>`).join("")||'<tr><td colspan="5">No models on this page</td></tr>'}</tbody></table>`;
      nextCursor=response.nextCursor;previous.disabled=history.length===0;next.disabled=!nextCursor;refresh.disabled=false;
    }
    async function finish(){
      if(closed||end.disabled)return;
      clear("Ending support…");end.disabled=true;
      const response=await window.OnlinodAdminApi.revokeSupport(grant.id,{reason:"Support view closed by administrator"});
      if(!response?.ok){end.disabled=false;body.textContent=response?.error||"Revocation not confirmed. Retry End support.";return;}
      dispose();
    }
    next.onclick=()=>{if(!nextCursor)return;history.push(cursor);cursor=nextCursor;void load();};
    previous.onclick=()=>{if(!history.length)return;cursor=history.pop();void load();};
    refresh.onclick=()=>void load();end.onclick=()=>void finish();
    dialog.addEventListener("cancel",event=>{event.preventDefault();void finish();});
    await load();
  }
  window.OnlinodAdminSupport={open};
})();
