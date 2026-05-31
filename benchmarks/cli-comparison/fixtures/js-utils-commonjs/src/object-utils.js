function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) {
      out[key] = obj[key];
    }
  }
  return out;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

module.exports = { pick, isPlainObject };
