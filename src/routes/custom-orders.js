"use strict";

const express = require("express");
const prisma = require("../prisma");
const {
  createCustomOrder,
  listCustomOrders,
  updateCustomOrder,
} = require("../services/custom-orders-service");

const router = express.Router();

function bool(value) {
  return value === true || value === "1" || String(value || "").toLowerCase() === "true";
}

function sendError(res, err, fallbackCode) {
  const status = Number(err?.status);
  return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: err?.code || fallbackCode,
    error: err?.message || "Request failed",
  });
}

router.get("/", async (req, res) => {
  try {
    const result = await listCustomOrders({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      creatorId: req.query.creatorId || null,
      dialogId: req.query.dialogId || null,
      status: req.query.status || null,
      pendingOnly: bool(req.query.pendingOnly),
      limit: req.query.limit,
      offset: req.query.offset,
      db: prisma,
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "CUSTOM_ORDERS_LIST_FAILED");
  }
});

router.post("/", async (req, res) => {
  try {
    const result = await createCustomOrder({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      input: req.body || {},
      db: prisma,
    });
    return res.status(201).json(result);
  } catch (err) {
    return sendError(res, err, "CUSTOM_ORDER_CREATE_FAILED");
  }
});

router.patch("/:orderId", async (req, res) => {
  try {
    const result = await updateCustomOrder({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      orderId: req.params.orderId,
      input: req.body || {},
      db: prisma,
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "CUSTOM_ORDER_UPDATE_FAILED");
  }
});

module.exports = router;
