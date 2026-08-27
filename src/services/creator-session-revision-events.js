"use strict";

const {
  publishDesktopControlEvent,
  waitForDesktopControlEvents,
  currentDesktopControlStreamId,
} = require("./desktop-control-events");

function publishCreatorSessionRevision(input) {
  const event = publishDesktopControlEvent({ ...input, type: "SESSION_REVISION_CHANGED" });
  return {
    seq: event.seq,
    creatorId: event.creatorId,
    revision: event.revision,
    status: event.status,
    sourceDeviceId: event.sourceDeviceId,
    requestId: event.requestId,
    emittedAt: event.emittedAt,
  };
}

async function waitForCreatorSessionRevisionEvents(input) {
  const result = await waitForDesktopControlEvents(input);
  return {
    streamId: result.streamId,
    cursor: result.cursor,
    events: result.events
      .filter((event) => event.type === "SESSION_REVISION_CHANGED")
      .map(({ type: _type, ...event }) => event),
  };
}

function currentCreatorSessionRevisionStreamId() {
  return currentDesktopControlStreamId();
}

module.exports = {
  publishCreatorSessionRevision,
  waitForCreatorSessionRevisionEvents,
  currentCreatorSessionRevisionStreamId,
};
