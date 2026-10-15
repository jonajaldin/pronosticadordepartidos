'use strict';

// Error con código estable, mensaje en español y el estado HTTP que devuelve nuestra API.
class ApiError extends Error {
  constructor(code, message, { status = 502, hint = null, retryAfter = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    if (this.retryAfter != null) out.retryAfter = this.retryAfter;
    return out;
  }
}

module.exports = { ApiError };
