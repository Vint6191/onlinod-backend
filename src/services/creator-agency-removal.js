"use strict";

function normalizeUsername(value) {
  const clean = String(value || "").trim().replace(/^@+/, "");
  return clean ? clean.toLowerCase() : null;
}

function agencyRemovalPhrase(creator) {
  const username = normalizeUsername(creator?.username);
  if (!username) throw new Error("Creator username is required for agency removal");
  return `DELETE @${username}`;
}

function removeCreatorFromAssignedCreators(value, creatorId) {
  const id = String(creatorId || "");
  const filterIds = (items) => items.map(String).filter((item) => item && item !== id);
  if (Array.isArray(value)) {
    const next = filterIds(value);
    const changed = next.length !== value.length;
    return { changed, value: changed ? next : value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { changed: false, value };
  if (Array.isArray(value.ids)) {
    const next = filterIds(value.ids);
    const changed = next.length !== value.ids.length;
    return { changed, value: changed ? { ...value, ids: next } : value };
  }
  if (Array.isArray(value.creatorIds)) {
    const next = filterIds(value.creatorIds);
    const changed = next.length !== value.creatorIds.length;
    return { changed, value: changed ? { ...value, creatorIds: next } : value };
  }
  return { changed: false, value };
}

module.exports = {
  agencyRemovalPhrase,
  removeCreatorFromAssignedCreators,
};
