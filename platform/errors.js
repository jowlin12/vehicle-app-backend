'use strict';

class PlatformError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reject(status, code, message) {
  throw new PlatformError(status, code, message);
}

module.exports = { PlatformError, reject };
