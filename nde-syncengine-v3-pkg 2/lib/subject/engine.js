'use strict';
/** FEATURE: Group subject/description — engine slice (admin only). */
const F = require('../common/frames');
const { ensure, requireAdmin } = require('../common/errors');
const { SubjectStore } = require('./storage');
class SubjectEngine {
  constructor({ storage }) { this.store = new SubjectStore(storage); this.s = storage; }
  async setSubject({ convId, by, field, value, ts, ulid }) {
    await requireAdmin(this.s, convId, by);
    ensure(field === 'subject' || field === 'description', F.E.BAD_FRAME, 'unknown metadata field');
    const { seq } = await this.store.set({ convId, by, field, value, ts, ulid });
    return { frame: F.subjectSet(convId, seq, by, field, value, ts), seq };
  }
}
module.exports = { SubjectEngine };
