import Feature from 'trac-peer/src/artifacts/feature.js';
import b4a from 'b4a';
import c from '../../node_modules/compact-encoding/index.js';

const toTopic = (name) => b4a.alloc(32).fill(name);
const toProtocol = (name) => `sidechannel/${name}`;

class Sidechannel extends Feature {
  constructor(peer, config = {}) {
    super(peer, config);
    this.key = 'sidechannel';
    this.channels = new Map();
    this.connections = new Map();
    this.rateLimits = new Map();
    this.started = false;
    this.onMessage = typeof config.onMessage === 'function' ? config.onMessage : null;
    this.debug = config.debug === true;
    this.maxMessageBytes = Number.isSafeInteger(config.maxMessageBytes)
      ? config.maxMessageBytes
      : 1_000_000;
    this.entryChannel = typeof config.entryChannel === 'string' ? config.entryChannel : null;
    this.allowRemoteOpen = config.allowRemoteOpen !== false;
    this.autoJoinOnOpen = config.autoJoinOnOpen === true;
    this.relayEnabled = config.relayEnabled !== false;
    this.relayTtl = Number.isSafeInteger(config.relayTtl) ? config.relayTtl : 3;
    this.maxSeen = Number.isSafeInteger(config.maxSeen) ? config.maxSeen : 5000;
    this.seenTtlMs = Number.isSafeInteger(config.seenTtlMs) ? config.seenTtlMs : 120_000;
    this.rateBytesPerSecond = Number.isSafeInteger(config.rateBytesPerSecond)
      ? config.rateBytesPerSecond
      : 64_000;
    this.rateBurstBytes = Number.isSafeInteger(config.rateBurstBytes)
      ? config.rateBurstBytes
      : 256_000;
    this.maxStrikes = Number.isSafeInteger(config.maxStrikes) ? config.maxStrikes : 3;
    this.strikeWindowMs = Number.isSafeInteger(config.strikeWindowMs) ? config.strikeWindowMs : 5000;
    this.blockMs = Number.isSafeInteger(config.blockMs) ? config.blockMs : 30_000;
    this.seen = new Map();

    const initial = Array.isArray(config.channels) ? config.channels : [];
    for (const name of initial) this._registerChannel(name);
  }

  _now() {
    return Date.now();
  }

  _getRemoteKey(connection) {
    return connection?.remotePublicKey ? b4a.toString(connection.remotePublicKey, 'hex') : 'unknown';
  }

  _purgeSeen(now) {
    const cutoff = now - this.seenTtlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
      else break;
    }
  }

  _rememberSeen(id, now) {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    if (this.seen.size > this.maxSeen) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    this._purgeSeen(now);
    return false;
  }

  _getLimiter(connection) {
    let state = this.rateLimits.get(connection);
    if (!state) {
      const now = this._now();
      state = {
        tokens: this.rateBurstBytes,
        lastRefill: now,
        strikes: 0,
        strikeResetAt: now + this.strikeWindowMs,
        blockedUntil: 0,
      };
      this.rateLimits.set(connection, state);
    }
    return state;
  }

  _isBlocked(connection) {
    const state = this.rateLimits.get(connection);
    if (!state) return false;
    return this._now() < state.blockedUntil;
  }

  _checkRate(connection, bytes) {
    const state = this._getLimiter(connection);
    const now = this._now();
    if (now < state.blockedUntil) return false;

    if (now > state.strikeResetAt) {
      state.strikes = 0;
      state.strikeResetAt = now + this.strikeWindowMs;
    }

    const elapsedMs = now - state.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * this.rateBytesPerSecond;
      state.tokens = Math.min(this.rateBurstBytes, state.tokens + refill);
      state.lastRefill = now;
    }

    if (bytes > state.tokens) {
      state.strikes += 1;
      if (state.strikes >= this.maxStrikes) {
        state.blockedUntil = now + this.blockMs;
        if (this.debug) {
          console.log(`[sidechannel] rate-limit block ${this._getRemoteKey(connection)} for ${this.blockMs}ms`);
        }
      }
      return false;
    }

    state.tokens -= bytes;
    return true;
  }

  _buildPayload(channel, message) {
    const ts = this._now();
    const from = this.peer?.wallet?.publicKey ?? null;
    const id = `${from ?? 'anon'}:${ts}:${Math.random().toString(36).slice(2, 10)}`;
    return {
      type: 'sidechannel',
      id,
      channel,
      from,
      origin: from,
      message,
      ts,
      ttl: this.relayTtl,
    };
  }

  requestOpen(newChannel, viaChannel = null) {
    const target = String(newChannel || '').trim();
    if (!target) return false;
    const via = String(viaChannel || this.entryChannel || '').trim();
    if (!via) return false;
    return this.broadcast(via, {
      control: 'open_channel',
      channel: target
    });
  }

  _relay(channel, payload, originConnection) {
    if (!this.relayEnabled) return;
    const ttl = Number.isFinite(payload?.ttl) ? payload.ttl : 0;
    if (ttl <= 0) return;
    const relayed = {
      ...payload,
      ttl: ttl - 1,
      relayedBy: this.peer?.wallet?.publicKey ?? null,
    };
    for (const [connection, perConn] of this.connections.entries()) {
      if (connection === originConnection) continue;
      const record = perConn.get(channel);
      if (record?.message) {
        record.message.send(relayed);
      }
    }
  }

  _registerChannel(name) {
    const channel = String(name || '').trim();
    if (!channel) return null;
    if (this.channels.has(channel)) return this.channels.get(channel);
    const entry = {
      name: channel,
      topic: toTopic(channel),
      protocol: toProtocol(channel)
    };
    this.channels.set(channel, entry);
    return entry;
  }

  _openChannelForConnection(connection, entry) {
    const mux = connection.userData;
    if (!mux || typeof mux.createChannel !== 'function') {
      const tries = (connection.__sidechannelMuxTries || 0) + 1;
      connection.__sidechannelMuxTries = tries;
      if (tries <= 5) {
        setTimeout(() => this._openChannelForConnection(connection, entry), 50);
      } else if (this.debug) {
        console.log(`[sidechannel:${entry.name}] mux not ready for connection.`);
      }
      return;
    }

    let perConn = this.connections.get(connection);
    if (!perConn) {
      perConn = new Map();
      this.connections.set(connection, perConn);
    }
    if (perConn.has(entry.name)) return;
    if (!perConn._paired) perConn._paired = new Set();
    if (!perConn._paired.has(entry.protocol)) {
      perConn._paired.add(entry.protocol);
      if (typeof mux.pair === 'function') {
        mux.pair({ protocol: entry.protocol }, () => {
          this._openChannelForConnection(connection, entry);
        });
      }
    }

    if (this.debug) {
      const remoteKey = connection?.remotePublicKey
        ? b4a.toString(connection.remotePublicKey, 'hex')
        : 'unknown';
      console.log(`[sidechannel:${entry.name}] opening channel for ${remoteKey}`);
    }

    const channel = mux.createChannel({
      protocol: entry.protocol,
      onopen() {},
      onclose() {}
    });
    if (!channel) {
      if (this.debug) {
        console.log(`[sidechannel:${entry.name}] channel already open or closed.`);
      }
      return;
    }

    const message = channel.addMessage({
      encoding: c.json,
      onmessage: (payload) => {
        if (this._isBlocked(connection)) return;
        let payloadJson = null;
        try {
          payloadJson = JSON.stringify(payload);
        } catch (_e) {
          return;
        }
        const payloadBytes = b4a.byteLength(payloadJson, 'utf8');
        if (this.debug) {
          console.log(
            `[sidechannel:${entry.name}] recv ${payloadBytes} bytes from ${this._getRemoteKey(connection)}`
          );
        }
        if (!this._checkRate(connection, payloadBytes)) {
          if (this.debug) {
            console.log(`[sidechannel:${entry.name}] drop (rate limit) from ${this._getRemoteKey(connection)}`);
          }
          return;
        }
        const payloadId =
          payload?.id ?? `${payload?.from ?? 'unknown'}:${payload?.ts ?? 0}:${payload?.channel ?? entry.name}`;
        const now = this._now();
        if (this._rememberSeen(payloadId, now)) {
          if (this.debug) {
            console.log(`[sidechannel:${entry.name}] drop (duplicate) ${payloadId}`);
          }
          return;
        }
        const control = payload?.message?.control;
        const requestedChannel = payload?.message?.channel;
        if (control === 'open_channel' && this.allowRemoteOpen && typeof requestedChannel === 'string') {
          const target = requestedChannel.trim();
          if (target.length > 0) {
            if (this.autoJoinOnOpen) {
              this.addChannel(target).catch(() => {});
              console.log(`[sidechannel] auto-joined channel: ${target}`);
            } else {
              console.log(`[sidechannel] channel request received: ${target}`);
            }
          }
        } else if (this.onMessage) {
          this.onMessage(entry.name, payload, connection);
        } else {
          const from = payload?.from ?? 'unknown';
          const msg = payload?.message ?? payload;
          console.log(`[sidechannel:${entry.name}] ${from}:`, msg);
        }
        this._relay(entry.name, payload, connection);
      }
    });

    channel.open();
    channel
      .fullyOpened()
      .then((opened) => {
        if (this.debug) {
          console.log(
            `[sidechannel:${entry.name}] channel open=${opened} for ${this._getRemoteKey(connection)}`
          );
        }
        if (!opened) {
          const retryCount = (record?.retries ?? 0) + 1;
          if (retryCount <= 5) {
            if (record) record.retries = retryCount;
            perConn.delete(entry.name);
            setTimeout(() => this._openChannelForConnection(connection, entry), 100 * retryCount);
          }
        }
      })
      .catch(() => {});

    const record = { channel, message, retries: 0 };
    perConn.set(entry.name, record);
  }

  async addChannel(name) {
    const entry = this._registerChannel(name);
    if (!entry) return false;
    if (this.started && this.peer?.swarm) {
      this.peer.swarm.join(entry.topic, { server: true, client: true });
      await this.peer.swarm.flush();
      for (const connection of this.connections.keys()) {
        this._openChannelForConnection(connection, entry);
      }
    }
    return true;
  }

  broadcast(name, message) {
    const channel = String(name || '').trim();
    if (!channel) return false;
    const entry = this._registerChannel(channel);
    if (!entry) return false;
    if (this.peer?.swarm?.connections) {
      for (const connection of this.peer.swarm.connections) {
        this._openChannelForConnection(connection, entry);
      }
    }
    const payload = this._buildPayload(channel, message);
    let payloadJson = null;
    try {
      payloadJson = JSON.stringify(payload);
    } catch (_e) {
      console.log(`[sidechannel:${channel}] message rejected (non-serializable payload).`);
      return false;
    }
    const payloadBytes = b4a.byteLength(payloadJson, 'utf8');
    if (payloadBytes > this.maxMessageBytes) {
      console.log(
        `[sidechannel:${channel}] message too large (${payloadBytes} bytes > ${this.maxMessageBytes}).`
      );
      return false;
    }
    if (this.debug) {
      console.log(`[sidechannel:${channel}] sending to ${this.connections.size} connections`);
    }
    this._rememberSeen(payload.id, this._now());
    for (const perConn of this.connections.values()) {
      const record = perConn.get(channel);
      if (record?.message) {
        if (!record.channel?.opened) {
          record.channel
            ?.fullyOpened()
            .then((opened) => {
              if (opened) record.message.send(payload);
            })
            .catch(() => {});
        } else {
          record.message.send(payload);
        }
      } else if (this.debug) {
        console.log(`[sidechannel:${channel}] no message session for connection.`);
      }
    }
    return true;
  }

  async start() {
    if (this.started) return;
    if (!this.peer?.swarm) {
      throw new Error('Sidechannel requires peer.swarm to be initialized.');
    }

    this.peer.swarm.on('connection', (connection) => {
      if (this._isBlocked(connection)) return;
      for (const entry of this.channels.values()) {
        this._openChannelForConnection(connection, entry);
      }

      connection.on('close', () => {
        this.connections.delete(connection);
      });
    });

    for (const entry of this.channels.values()) {
      this.peer.swarm.join(entry.topic, { server: true, client: true });
    }
    await this.peer.swarm.flush();

    if (this.peer.swarm.connections) {
      for (const connection of this.peer.swarm.connections) {
        for (const entry of this.channels.values()) {
          this._openChannelForConnection(connection, entry);
        }
      }
    }
    this.started = true;
  }

  async stop() {
    this.started = false;
    this.connections.clear();
  }
}

export default Sidechannel;
