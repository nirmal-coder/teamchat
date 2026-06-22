'use strict';
/**
 * Interest-based cross-gateway fan-out over Redis Pub/Sub. A gateway
 * subscribes to conv:{id} only while it holds >=1 local socket interested in
 * it, so broadcast cost is O(gateways-with-interest), not O(all gateways).
 */
class FanOut {
  constructor({ pub, sub }) {
    this.pub = pub; this.sub = sub;
    this.interest = new Map();
    this.onMessage = null;
    this.sub.on('messageBuffer', (channelBuf, message) => {
      const channel = channelBuf.toString();
      if (channel.startsWith('conv:') && this.onMessage) this.onMessage(channel.slice(5), message);
    });
  }
  async addInterest(convId) {
    const n = (this.interest.get(convId) || 0) + 1;
    this.interest.set(convId, n);
    if (n === 1) await this.sub.subscribe(`conv:${convId}`);
  }
  async removeInterest(convId) {
    const n = (this.interest.get(convId) || 0) - 1;
    if (n <= 0) { this.interest.delete(convId); await this.sub.unsubscribe(`conv:${convId}`); }
    else this.interest.set(convId, n);
  }
  publish(convId, frameBuffer) { return this.pub.publishBuffer(`conv:${convId}`, frameBuffer); }
}
module.exports = { FanOut };
