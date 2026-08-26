/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {value is Record<string, any>}
 */
export const hasExactKeys = (value, keys) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
);
