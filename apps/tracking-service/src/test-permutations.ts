// Test helper only.

/** Every order of the items. */
export function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations(items.filter((_other, i) => i !== index)).map((rest) => [item, ...rest]),
  )
}
