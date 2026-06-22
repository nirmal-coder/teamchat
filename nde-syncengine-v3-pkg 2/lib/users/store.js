'use strict';
const crypto   = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const { ulid }  = require('../common/ulid');

const ITER = 100_000;
const KEYLEN = 64;

function hash(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, ITER, KEYLEN, 'sha256', (e, key) =>
      e ? reject(e) : resolve(key.toString('hex'))
    )
  );
}

class UserStore {
  constructor({ db, jwtSecret }) {
    this.col    = db.collection('users');
    this.secret = new TextEncoder().encode(jwtSecret);
  }

  async init() {
    await this.col.createIndex({ username: 1 }, { unique: true });
  }

  async register(username, password) {
    if (!username || !password) throw Object.assign(new Error('username and password required'), { status: 400 });
    const salt   = crypto.randomBytes(32).toString('hex');
    const hashed = await hash(password, salt);
    const userId = ulid();
    try {
      await this.col.insertOne({ _id: userId, username, hash: hashed, salt, createdAt: Date.now() });
    } catch (e) {
      if (e.code === 11000) throw Object.assign(new Error('username taken'), { status: 409 });
      throw e;
    }
    return userId;
  }

  async login(username, password) {
    const user = await this.col.findOne({ username });
    if (!user) throw Object.assign(new Error('invalid credentials'), { status: 401 });
    const hashed = await hash(password, user.salt);
    if (hashed !== user.hash) throw Object.assign(new Error('invalid credentials'), { status: 401 });
    const token = await new SignJWT({ sub: user._id, username: user.username })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(this.secret);
    return { userId: user._id, username: user.username, token };
  }

  async verify(token) {
    const { payload } = await jwtVerify(token, this.secret);
    return { userId: payload.sub, username: payload.username };
  }

  async listAll() {
    const users = await this.col.find({}, { projection: { _id: 1, username: 1 } }).toArray();
    return users.map(u => ({ userId: u._id, username: u.username }));
  }

  async findById(userId) {
    const u = await this.col.findOne({ _id: userId }, { projection: { _id: 1, username: 1 } });
    return u ? { userId: u._id, username: u.username } : null;
  }
}

module.exports = { UserStore };
