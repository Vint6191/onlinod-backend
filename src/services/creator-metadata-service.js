"use strict";
const { runDbTransaction } = require("./db-transaction-service");
const { lockHumanCreatorMutation } = require("./creator-human-management-authority-service");
const { fail } = require("./management-command-contract");
async function updateCreatorMetadata({ db, agencyId, actorMember, creatorId, input }) {
  return runDbTransaction(db, async (tx) => {
    const { creator } = await lockHumanCreatorMutation({ tx, agencyId, actorMember, creatorId });
    if (new Date(creator.updatedAt).toISOString() !== input.expectedUpdatedAt)
      throw fail("CREATOR_METADATA_VERSION_CONFLICT", "Creator metadata changed; refresh before editing");
    const username =
      input.username === undefined ? creator.username : input.username.trim().replace(/^@+/, "").toLowerCase();
    if (
      input.username !== undefined &&
      creator.remoteId &&
      String(creator.platformUsername || creator.username).toLowerCase() !== username
    )
      throw fail(
        "CREATOR_PLATFORM_USERNAME_OBSERVATION_REQUIRED",
        "Connected usernames require a verified platform observation"
      );
    if (input.username !== undefined) {
      const conflict = await tx.creatorAccount.findFirst({
        where: {
          agencyId,
          deletedAt: null,
          id: { not: creatorId },
          OR: ["username", "platformUsername", "enrollmentExpectedUsername"].map((key) => ({
            [key]: { equals: username, mode: "insensitive" },
          })),
        },
      });
      if (conflict) throw fail("CREATOR_ALREADY_EXISTS", "This OnlyFans username is already active");
    }
    return tx.creatorAccount.update({
      where: { id: creatorId },
      data: {
        displayName: input.displayName,
        notes: input.notes === undefined ? undefined : input.notes || null,
        username: input.username === undefined ? undefined : username,
        enrollmentExpectedUsername: input.username === undefined || creator.remoteId ? undefined : username,
      },
    });
  });
}
module.exports = { updateCreatorMetadata };
