function capitalize(value) {
  if (value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1);
}

function kebabCase(value) {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

module.exports = { capitalize, kebabCase };
