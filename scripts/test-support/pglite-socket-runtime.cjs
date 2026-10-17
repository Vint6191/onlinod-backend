"use strict";

// PGlite has one PostgreSQL session. This adapter is only for isolated SQL
// proofs: it retires a socket completely before resetting that shared session.
// pglite-socket 0.2.13 removes a handler only after its `close` event, but its
// error path detaches the socket's close listener first. ECONNRESET therefore
// leaves a phantom connection slot and can hang server.stop().
async function createPgliteSocketServer({ engine, load, maxConnections = 1, debug = false }) {
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections, debug });
  if (!(server.handlers instanceof Set) || typeof server.handleConnection !== "function") {
    throw Error("UNSUPPORTED_PGLITE_SOCKET_FIXTURE_API");
  }
  const retirements = new Set();
  const attach = server.handleConnection.bind(server);
  const stop = server.stop.bind(server);
  server.addEventListener("connection", () => {
    for (const handler of server.handlers) {
      if (handler.fixtureRetirementWrapped) continue;
      handler.fixtureRetirementWrapped = true;
      const detach = handler.detach.bind(handler);
      let retired;
      handler.detach = (close) => {
        if (!retired) {
          retired = detach(close).finally(() => {
            server.handlers.delete(handler);
            retirements.delete(retired);
          });
          retirements.add(retired);
        }
        return retired;
      };
    }
  });
  let admission = Promise.resolve();
  server.handleConnection = (socket) => {
    socket.pause();
    const attached = admission.then(async () => {
      // A peer can already be destroyed before the library's deferred close
      // callback runs. Do not let that callback overlap the next session reset.
      for (const handler of [...server.handlers]) {
        if (!handler.isAttached || handler.socket?.destroyed) await handler.detach(false);
      }
      await Promise.all([...retirements]);
      if (server.handlers.size === 0) await engine.exec("DISCARD ALL");
      await attach(socket);
      socket.resume();
    });
    admission = attached.catch(error => {
      socket.destroy(error);
      server.dispatchEvent(new CustomEvent("error", { detail: error }));
    });
    return admission;
  };
  server.waitForIdle = async () => {
    const deadline = Date.now() + 10000;
    while (server.handlers.size || retirements.size || server.getStats().queuedQueries) {
      if (Date.now() >= deadline) {
        throw Error("PGLITE_FIXTURE_HANDOFF_NOT_IDLE: " + JSON.stringify(server.getStats()));
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await engine.runExclusive(async () => {});
  };
  server.stop = async () => {
    await admission;
    await Promise.all([...server.handlers].map(handler => handler.detach(true)));
    await Promise.all([...retirements]);
    await stop();
  };
  await server.start();
  return server;
}

module.exports = { createPgliteSocketServer };
