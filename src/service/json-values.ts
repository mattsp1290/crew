export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === null) return right === null;
  if (typeof left === 'number') return Number.isFinite(left) && typeof right === 'number' && Number.isFinite(right) && left === right;
  if (typeof left === 'string' || typeof left === 'boolean') return left === right;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const keys = Object.keys(left);
  const rightKeys = new Set(Object.keys(right));
  return keys.length === rightKeys.size && keys.every((key) =>
    rightKeys.has(key) && sameJsonValue(left[key], right[key]));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
