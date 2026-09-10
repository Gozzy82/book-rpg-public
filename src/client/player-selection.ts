export function resolvePlayerSelection(
  raw: string,
  characters: readonly string[],
): string | undefined {
  const selectedIndex = Number(raw.trim()) - 1;
  if (
    !Number.isInteger(selectedIndex)
    || selectedIndex < 0
    || selectedIndex >= characters.length
  ) {
    return undefined;
  }
  return characters[selectedIndex];
}
