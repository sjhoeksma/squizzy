/**
 * Simple object check.
 * @param item
 * @returns {boolean}
 */
function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Deep merge two objects return new one
 * @param target
 * @param ...sources
 */
function mergeDeep(target, ...sources) {
  let output = Object.assign({}, target);
  while (sources.length) {
    const source = sources.shift();
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target)) Object.assign(output, { [key]: source[key] });
          else output[key] = mergeDeep(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
  }
  return output;
}

module.exports = mergeDeep;
