"use strict";
class CampaignTraversalError extends Error {
  constructor(code) { super(code); this.name = "CampaignTraversalError"; this.code = code; this.status = 409; }
}
module.exports = { CampaignTraversalError };
