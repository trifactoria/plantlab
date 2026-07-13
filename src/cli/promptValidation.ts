export function parseStrictMenuChoice(input: string, count: number, fallback: number): number | null {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= count ? value : null;
}
