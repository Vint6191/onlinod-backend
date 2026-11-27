"use strict";

// This is an ownership proof, not permission to transfer a device or its key.
// Only immutable authenticated User.id participates in the desktop binding.
async function principalDeviceContext({ db, userId, agencyId, deviceId }) {
  if (!deviceId) return { deviceId: null, owned: false, fingerprint: null };
  const [device, current, foreign] = await Promise.all([
    db.workerDevice.findUnique({ where: { id: deviceId }, select: { userId: true } }),
    db.deviceCryptoIdentity.findUnique({ where: { agencyId_deviceId: { agencyId, deviceId } }, select: { userId: true, fingerprint: true } }),
    db.deviceCryptoIdentity.findFirst({ where: { deviceId, userId: { not: userId } }, select: { deviceId: true } }),
  ]);
  if ((device && device.userId !== userId) || foreign) return { deviceId, owned: false, unclaimed: false, fingerprint: null };
  const identity = current || await db.deviceCryptoIdentity.findFirst({
    where: { deviceId, userId }, select: { fingerprint: true },
  });
  const owned = device?.userId === userId || Boolean(identity);
  return { deviceId, owned, unclaimed: !device && !identity, fingerprint: owned ? identity?.fingerprint || null : null };
}

module.exports = { principalDeviceContext };
