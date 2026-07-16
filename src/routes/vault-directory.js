"use strict";

const express = require("express");
const {
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
} = require("../services/vault-directory-service");

const { automationCreatorParamRequired } = require("../middleware/automation-permissions");

const router = express.Router();
router.param("creatorId", automationCreatorParamRequired());

function sendError(res, error, fallbackCode) {
  const code = error?.code || fallbackCode;
  const status = code === "CREATOR_NOT_FOUND" ? 404 : code === "MEDIA_IDS_INVALID" ? 400 : 500;
  return res.status(status).json({ ok: false, code, error: String(error?.message || error || "Vault directory request failed") });
}

router.post("/:creatorId/intelligence", async (req, res) => {
  try {
    const result = await getVaultDirectoryIntelligence({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: req.body?.mediaIds || [],
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "VAULT_DIRECTORY_INTELLIGENCE_FAILED");
  }
});

router.post("/:creatorId/protection-check", async (req, res) => {
  try {
    const result = await checkProtectedVaultMedia({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: req.body?.mediaIds || [],
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "VAULT_DIRECTORY_PROTECTION_CHECK_FAILED");
  }
});

module.exports = router;
