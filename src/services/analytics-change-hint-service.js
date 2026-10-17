"use strict";
const {currentCommitContext,deferCommitHint}=require("./db-commit-kernel");
const recent=new Map();
function publish(agencyId) {
  const context=currentCommitContext();
  if(context){deferCommitHint(context,`analytics-changed:${agencyId}`,()=>publish(agencyId));return;}
  require("./home-read-cache").invalidateAgency(agencyId);
  const now=performance.now();
  if(recent.has(agencyId)&&now-recent.get(agencyId)<500)return;
  recent.delete(agencyId);while(recent.size>=1000)recent.delete(recent.keys().next().value);recent.set(agencyId,now);
  // Only a hint, with no creator identity, amounts or authorization grant.
  // Other replicas and interrupted streams converge via the existing read TTL.
  require("./desktop-control-events").publishDesktopControlEvent({type:"ANALYTICS_CHANGED",agencyId});
}
module.exports={publish};
