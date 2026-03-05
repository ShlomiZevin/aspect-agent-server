/**
 * Board Events SSE Service
 *
 * Broadcasts real-time board events (task/comment changes) to all
 * connected clients. Unlike notifications (per-user), this is a
 * global broadcast so everyone on the board sees live updates.
 */
class BoardEventsService {
  constructor() {
    this.clients = new Set();
  }

  addClient(res) {
    this.clients.add(res);
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  emit(event) {
    if (this.clients.size === 0) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { /* client disconnected */ }
    }
  }
}

module.exports = new BoardEventsService();
