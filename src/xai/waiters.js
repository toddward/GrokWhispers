'use strict';

// Small helper shared by the xAI socket clients: lets a caller await the first
// server event matching a predicate, with a timeout, and optionally fail fast
// when the server reports an error.
class EventWaiters {
  constructor() {
    this.waiters = new Set();
  }

  waitFor(match, { timeoutMs = 20000, rejectOnError = false, label = 'event' } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        rejectOnError,
        resolve: (ev) => { cleanup(); resolve(ev); },
        reject: (err) => { cleanup(); reject(err); },
      };
      const timer = setTimeout(
        () => waiter.reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs,
      );
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      this.waiters.add(waiter);
    });
  }

  dispatch(ev) {
    for (const w of [...this.waiters]) {
      if (ev.type === 'error' && w.rejectOnError) {
        w.reject(serverError(ev));
      } else if (w.match(ev)) {
        w.resolve(ev);
      }
    }
  }

  failAll(err) {
    for (const w of [...this.waiters]) w.reject(err);
  }
}

function serverError(ev) {
  const e = ev.error || ev;
  const err = new Error(`xAI error: ${e.message || e.code || JSON.stringify(e)}`);
  err.server = e;
  return err;
}

module.exports = { EventWaiters, serverError };
