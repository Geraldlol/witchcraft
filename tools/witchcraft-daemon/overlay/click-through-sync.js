export class ClickThroughSynchronizer {
  constructor({ send, onError = () => {}, initial = false } = {}) {
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    if (typeof initial !== 'boolean') throw new TypeError('initial must be a boolean');
    this.send = send;
    this.onError = onError;
    this.desired = initial;
    this.acknowledged = initial;
    this.inFlight = null;
    this.idleWaiters = [];
  }

  setDesired(value) {
    if (typeof value !== 'boolean') throw new TypeError('click-through intent must be a boolean');
    this.desired = value;
    this.#pump();
    return this.whenIdle();
  }

  observe(value) {
    if (typeof value !== 'boolean') return false;
    this.acknowledged = value;
    if (!this.inFlight) this.desired = value;
    this.#pump();
    return value === this.desired;
  }

  whenIdle() {
    if (!this.inFlight && this.desired === this.acknowledged) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  #pump() {
    if (this.inFlight || this.desired === this.acknowledged) {
      this.#resolveIdle();
      return;
    }

    const target = this.desired;
    const request = { target, promise: null };
    this.inFlight = request;
    try {
      request.promise = Promise.resolve(this.send(target));
    } catch (error) {
      request.promise = Promise.reject(error);
    }

    void request.promise
      .then(() => {
        this.acknowledged = target;
      })
      .catch(error => {
        if (this.desired === target) this.desired = this.acknowledged;
        try { this.onError(error, this.acknowledged); } catch { /* Error reporting must not stall synchronization. */ }
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
        this.#pump();
      });
  }

  #resolveIdle() {
    if (this.inFlight || this.desired !== this.acknowledged) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
