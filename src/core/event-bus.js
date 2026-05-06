export class EventBus {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    (this.listeners[event] ||= []).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const list = this.listeners[event];
    if (list) {
      this.listeners[event] = list.filter((cb) => cb !== callback);
    }
  }

  emit(event, data) {
    for (const cb of this.listeners[event] || []) {
      try {
        cb(data);
      } catch {}
    }
    for (const cb of this.listeners["*"] || []) {
      try {
        cb(event, data);
      } catch {}
    }
  }

  removeAll() {
    this.listeners = {};
  }
}
