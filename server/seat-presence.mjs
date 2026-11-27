/**
 * 席位续租：给断线的玩家留一个「原席位」。
 *
 * 新联机工程的统一约定（见 docs/NETPLAY_ENGINEERING_GUIDE.md）：
 * - 意外断开保留 20 秒，期间原席位不被别人占走；
 * - 同一标签页带着 token 回来就坐回原位，不用重新选角/选图；
 * - 主动离开或超时才真正释放。
 *
 * 这里只做纯粹的租约记账，不碰 socket、不碰游戏逻辑，方便单测。
 */
import {randomBytes} from 'node:crypto';

export const DEFAULT_RESUME_GRACE_MS = 20_000;

const TOKEN_PATTERN = /^[a-f0-9]{16,64}$/;

export class SeatPresence {
  /**
   * @param {object} options
   * @param {number} options.capacity 席位数
   * @param {number} [options.graceMs] 断线保留时长
   * @param {(slot:number)=>void} [options.onExpire] 租约到期时通知宿主
   * @param {()=>number} [options.now]
   */
  constructor({capacity, graceMs = DEFAULT_RESUME_GRACE_MS, onExpire = null, now = Date.now} = {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)
      throw new RangeError('SeatPresence capacity must be 1..8');
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 300_000)
      throw new RangeError('SeatPresence graceMs must be 0..300000');
    this.capacity = capacity;
    this.graceMs = graceMs;
    this.now = now;
    this.onExpire = onExpire;
    /** @type {Array<{token:string, expiresAt:number|null, timer:any}>} */
    this.slots = new Array(capacity).fill(null);
    this.tokens = new Map();
  }

  /** 给某个席位发一张新票；同一席位旧票立即失效。 */
  issue(slot) {
    this.#assertSlot(slot);
    this.#clear(slot);
    const token = randomBytes(16).toString('hex');
    this.slots[slot] = {token, expiresAt: null, timer: null};
    this.tokens.set(token, slot);
    return token;
  }

  /** 断线：保留席位 graceMs，到期由 onExpire 通知宿主。 */
  hold(slot) {
    this.#assertSlot(slot);
    const lease = this.slots[slot];
    if (!lease) return null;
    if (lease.timer) clearTimeout(lease.timer);
    lease.expiresAt = this.now() + this.graceMs;
    lease.timer = setTimeout(() => {
      if (this.slots[slot]?.token !== lease.token) return;
      this.#clear(slot);
      this.onExpire?.(slot);
    }, this.graceMs);
    lease.timer.unref?.();
    return lease.expiresAt;
  }

  /** 带着票回来：票有效就返回原席位，并把租约恢复成「在用」。 */
  claim(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const slot = this.tokens.get(token);
    if (slot === undefined) return null;
    const lease = this.slots[slot];
    if (!lease || lease.token !== token) return null;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    lease.expiresAt = null;
    return slot;
  }

  /** 主动离开、被顶替、房间关闭时调用。 */
  release(slot) {
    this.#assertSlot(slot);
    this.#clear(slot);
  }

  isReserved(slot) {
    return Boolean(this.slots[slot]?.expiresAt);
  }

  /** 当前被保留（断线等待中）的席位号。 */
  reservedSlots() {
    return this.slots.map((lease, slot) => lease?.expiresAt ? slot : null).filter(v => v !== null);
  }

  expiresAt(slot) {
    return this.slots[slot]?.expiresAt ?? null;
  }

  dispose() {
    for (let slot = 0; slot < this.capacity; slot++) this.#clear(slot);
  }

  #clear(slot) {
    const lease = this.slots[slot];
    if (!lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    this.tokens.delete(lease.token);
    this.slots[slot] = null;
  }

  #assertSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity)
      throw new RangeError('SeatPresence slot out of range: ' + slot);
  }
}
