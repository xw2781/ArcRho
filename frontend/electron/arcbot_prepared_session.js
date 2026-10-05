// One unused, read-only thread per renderer. A send consumes it; the next
// preparation never reuses a conversation containing stale page context.
class PreparedArcBotSessions {
  constructor() { this.entries = new Map(); }

  release(owner) {
    const entry = this.entries.get(owner);
    this.entries.delete(owner);
    if (entry) void entry.promise.then(({ client, threadId }) => {
      if (client.isAlive()) return client.request("thread/unsubscribe", { threadId }, 5000);
    }).catch(() => {});
  }

  async prepare(owner, sessionId, model, cwd, client) {
    const key = JSON.stringify([sessionId, model, cwd]);
    const existing = this.entries.get(owner);
    if (existing?.key === key && existing.process === client.proc) return existing.promise;
    this.release(owner);
    const entry = { key, process: client.proc };
    entry.promise = client.startThread("review", cwd, model).then(threadId => ({ client, threadId }));
    this.entries.set(owner, entry);
    try { return await entry.promise; }
    catch (error) {
      if (this.entries.get(owner) === entry) this.entries.delete(owner);
      throw error;
    }
  }

  async take(owner, sessionId, model, cwd, client) {
    const prepared = await this.prepare(owner, sessionId, model, cwd, client);
    const entry = this.entries.get(owner);
    if (entry && await entry.promise === prepared) this.entries.delete(owner);
    return prepared;
  }

  clear() { for (const owner of this.entries.keys()) this.release(owner); }
}

module.exports = { PreparedArcBotSessions };
