/**
 * Live board updates over SSE.
 *
 * One broadcast to everyone connected, which is correct here in a way it was
 * not before: this process serves one board, in its own database, so there is
 * no second audience an event could leak to. The old shared board had to route
 * events per client and got it wrong -- every subscriber received every task
 * object regardless of who it belonged to.
 */
const HEARTBEAT_MS = 25_000;

class BoardEvents {
  constructor() {
    this.clients = new Set();
  }

  /**
   * Registers a response stream and returns the function that tears it down.
   * Returning the cleanup means a caller cannot register without also having
   * the means to unregister, which is how the old version leaked connections
   * when a route forgot its 'close' handler.
   */
  subscribe(res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Nginx and Cloud Run's proxy will otherwise buffer the stream and deliver
    // nothing until it closes.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.clients.add(res);

    // Comment frames, not events: they keep the connection and any intermediary
    // awake without the client having to recognise a "ping" message type.
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* closing */ }
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
  }

  emit(event) {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        // A dead socket must not stop the rest of the broadcast, and holding a
        // reference to it leaks memory until the process restarts.
        this.clients.delete(res);
      }
    }
  }

  get size() {
    return this.clients.size;
  }
}

module.exports = new BoardEvents();
