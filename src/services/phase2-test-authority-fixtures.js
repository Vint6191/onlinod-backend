"use strict";

function cloneRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
}

function normalizeMember(row) {
  if (!row) return null;
  return {
    ...row,
    id: row.id,
    agencyId: row.agencyId || "agency-1",
    userId: row.userId || `user-${row.id}`,
    role: row.role || "MANAGER",
    roleKey: row.roleKey || "manager",
    accessEpoch: Number.isInteger(Number(row.accessEpoch)) ? Number(row.accessEpoch) : 1,
    assignedCreators: row.assignedCreators ?? "all",
    permissions: {
      "money.claim": true,
      "money.release_own_claim": true,
      "money.resolve_attribution": true,
      "money.override_attribution": true,
      "workspace.manage_schedule": true,
      "workspace.manage_settings": true,
      "workspace.invite": true,
      "workspace.edit_roles": true,
      ...(row.permissions || {}),
    },
  };
}

function activeAgency(agencyId = "agency-1") {
  return { id: String(agencyId), deletedAt: null, status: "ACTIVE" };
}

function attachManagementAuthority(tx, { agencyId = "agency-1", actor = null } = {}) {
  if (!tx || typeof tx !== "object") return tx;
  const normalizedActor = normalizeMember(actor || {
    id: "manager",
    agencyId,
    userId: "user-manager",
    role: "MANAGER",
    roleKey: "manager",
    assignedCreators: "all",
  });

  const originalUnsafe = typeof tx.$queryRawUnsafe === "function" ? tx.$queryRawUnsafe.bind(tx) : null;
  if (originalUnsafe) {
    tx.$queryRawUnsafe = async function phase2AuthorityQuery(sql, ...args) {
      const text = String(sql || "");
      if (text.includes('FROM "Agency"')) return [activeAgency(args[0] || agencyId)];
      if (text.includes('FROM "CreatorAccount"')) {
        const creatorId = String(args[0] || "");
        const targetAgencyId = String(args[1] || agencyId);
        return creatorId && targetAgencyId === String(agencyId) ? [{ id: creatorId }] : [];
      }
      if (text.includes('FROM "AgencyMember"')) return normalizedActor ? [{ id: normalizedActor.id }] : [];
      if (text.includes('FROM "User"')) return normalizedActor ? [{ id: normalizedActor.userId }] : [];
      return originalUnsafe(sql, ...args);
    };
  }

  if (!tx.agency) {
    tx.agency = {
      async findUnique({ where }) { return activeAgency(where?.id || agencyId); },
      async findFirst({ where }) { return activeAgency(where?.id || agencyId); },
    };
  }
  if (!tx.agencyRoleOverride) tx.agencyRoleOverride = { async findUnique() { return null; } };
  if (!tx.agencySubPermissionOverride) tx.agencySubPermissionOverride = { async findMany() { return []; } };

  // Management commit authority now proves referenced Creator identities at commit
  // time. Test fixtures that are not exercising Creator retirement should model
  // that storage independently from the actor's creator scope. Scope is checked
  // later against the live member row; storage existence is a separate fact.
  const existingCreator = tx.creatorAccount || {};
  if (typeof existingCreator.findMany !== "function") {
    tx.creatorAccount = {
      ...existingCreator,
      async findMany(args = {}) {
        const ids = Array.isArray(args?.where?.id?.in) ? args.where.id.in : [];
        return ids.map((id) => ({ id: String(id) }));
      },
    };
  }

  const existingMember = tx.agencyMember || {};
  const originalFindFirst = typeof existingMember.findFirst === "function" ? existingMember.findFirst.bind(existingMember) : null;
  tx.agencyMember = {
    ...existingMember,
    async findFirst(args = {}) {
      const where = args.where || {};
      if (normalizedActor && String(where.id || "") === String(normalizedActor.id)) {
        if (where.userId && String(where.userId) !== String(normalizedActor.userId)) return null;
        if (where.agencyId && String(where.agencyId) !== String(normalizedActor.agencyId)) return null;
        return { ...normalizedActor };
      }
      return originalFindFirst ? originalFindFirst(args) : null;
    },
  };
  return tx;
}

async function rowsFromModel(model, args = {}) {
  if (!model?.findMany) return [];
  return cloneRows(await model.findMany(args));
}

function activeMoneyStatus(row, sourceType) {
  const status = String(row?.status || "").toLowerCase();
  const financial = String(row?.financialStatus || "active").toLowerCase();
  if (["refunded", "reversed", "void", "cancelled", "canceled"].includes(financial)) return false;
  return sourceType === "TIP"
    ? ["attributed", "claimed", "resolved"].includes(status)
    : ["attributed", "resolved"].includes(status);
}

function mapLedgerRow(row, sourceType) {
  if (sourceType === "TIP") {
    return {
      id: `fact-tip-${row.id || row.eventHash || Math.random()}`,
      agencyId: row.agencyId,
      sourceType: "TIP",
      sourceId: row.id || row.eventHash,
      externalId: row.eventHash || row.id,
      creatorId: row.creatorId || row.accountId || null,
      fanId: row.fanId || row.dialogId || null,
      dialogId: row.dialogId || row.fanId || null,
      memberId: row.attributedMemberId || null,
      amountCents: Number(row.amountCents || 0),
      currency: row.currency || "USD",
      occurredAt: row.receivedAt || row.occurredAt || row.createdAt || new Date(),
      attributionActive: activeMoneyStatus(row, "TIP") && Boolean(row.attributedMemberId),
    };
  }
  return {
    id: `fact-ppv-${row.id || row.purchaseId || Math.random()}`,
    agencyId: row.agencyId,
    sourceType: "PPV",
    sourceId: row.id || row.purchaseId,
    externalId: row.purchaseId || row.id,
    creatorId: row.creatorId || row.accountId || null,
    fanId: row.fanId || row.dialogId || null,
    dialogId: row.dialogId || row.fanId || null,
    memberId: row.attributedMemberId || null,
    amountCents: Number(row.amountCents || 0),
    currency: row.currency || "USD",
    occurredAt: row.purchasedAt || row.createdAt || new Date(),
    attributionActive: activeMoneyStatus(row, "PPV") && Boolean(row.attributedMemberId),
  };
}

function matchesSourceType(args, type) {
  const wanted = String(args?.where?.sourceType || "").toUpperCase();
  return !wanted || wanted === type;
}

function matchesMemberNotNull(args, row) {
  const memberFilter = args?.where?.memberId;
  if (memberFilter && typeof memberFilter === "object" && Object.prototype.hasOwnProperty.call(memberFilter, "not") && memberFilter.not === null) {
    return Boolean(row.memberId);
  }
  return true;
}

function attachHistoricalAuthority(fake, { coverageFrom = new Date("2100-01-01T00:00:00.000Z") } = {}) {
  if (!fake || typeof fake !== "object") return fake;
  if (!fake.systemSetting) fake.systemSetting = { async findUnique() { return null; } };
  if (!fake.teamHistoricalAnalyticsCoverage) {
    fake.teamHistoricalAnalyticsCoverage = {
      async findUnique({ where } = {}) {
        return {
          agencyId: where?.agencyId || "agency-1",
          activityCoverageFrom: coverageFrom,
          moneyCoverageFrom: new Date("2000-01-01T00:00:00.000Z"),
          activityProjectionVersion: "team_activity_daily_v1",
          moneyProjectionVersion: "team_money_fact_v1",
          source: "phase2_test_fixture_bridge",
        };
      },
    };
  }
  if (!fake.teamMemberActivityDaily) {
    fake.teamMemberActivityDaily = { async findMany() { return []; } };
  }
  if (!fake.teamMoneyAttributionFact) {
    fake.teamMoneyAttributionFact = {
      async findMany(args = {}) {
        let rows = [];
        if (matchesSourceType(args, "PPV")) rows.push(...(await rowsFromModel(fake.teamPpvPurchaseLedger, args)).map((row) => mapLedgerRow(row, "PPV")));
        if (matchesSourceType(args, "TIP")) rows.push(...(await rowsFromModel(fake.teamTipLedger, args)).map((row) => mapLedgerRow(row, "TIP")));
        return rows.filter((row) => matchesMemberNotNull(args, row));
      },
      async groupBy(args = {}) {
        const requested = String(args?.where?.sourceType || "").toUpperCase();
        const direct = [];
        const sourceModels = requested === "TIP"
          ? [[fake.teamTipLedger, "TIP"]]
          : requested === "PPV"
            ? [[fake.teamPpvPurchaseLedger, "PPV"]]
            : [[fake.teamPpvPurchaseLedger, "PPV"], [fake.teamTipLedger, "TIP"]];
        for (const [model, sourceType] of sourceModels) {
          if (model?.groupBy) {
            const rows = await model.groupBy(args);
            for (const row of rows || []) {
              direct.push({
                memberId: row.memberId || row.attributedMemberId || null,
                currency: row.currency || "USD",
                _sum: { amountCents: Number(row?._sum?.amountCents || 0) },
                sourceType,
              });
            }
          }
        }
        if (direct.length || sourceModels.some(([model]) => model?.groupBy)) return direct;

        let facts = await this.findMany(args);
        facts = facts.filter((row) => row.attributionActive === true && matchesMemberNotNull(args, row));
        const grouped = new Map();
        for (const row of facts) {
          const key = `${row.memberId || ""}|${row.currency || "USD"}`;
          const existing = grouped.get(key) || { memberId: row.memberId || null, currency: row.currency || "USD", _sum: { amountCents: 0 } };
          existing._sum.amountCents += Number(row.amountCents || 0);
          grouped.set(key, existing);
        }
        return [...grouped.values()];
      },
    };
  }
  return fake;
}

function phase2AnalyticsFixture(fake, options) {
  return attachHistoricalAuthority(fake, options);
}

function phase2ManagerActor({ id = "manager", userId = "user-manager", agencyId = "agency-1", creatorIds = "all", permissions = {} } = {}) {
  return normalizeMember({ id, userId, agencyId, role: "MANAGER", roleKey: "manager", accessEpoch: 1, assignedCreators: creatorIds, permissions });
}

module.exports = {
  attachHistoricalAuthority,
  attachManagementAuthority,
  phase2AnalyticsFixture,
  phase2ManagerActor,
};
