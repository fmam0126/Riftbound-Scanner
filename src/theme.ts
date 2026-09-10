/**
 * Visual constants.
 *
 * A dark palette is used deliberately: the scanner screen is mostly a live
 * camera preview, and a dark surround reduces glare and makes the framing guide
 * easier to see than a bright UI would.
 */

export const colors = {
  background: '#0B1020',
  surface: '#151B31',
  surfaceRaised: '#1E2540',
  border: '#2A3352',
  text: '#F2F5FF',
  textMuted: '#97A0BE',
  textFaint: '#5F6A8C',
  accent: '#3DDC97',
  accentDark: '#12281F',
  warn: '#FFB454',
  danger: '#FF6B6B',
  info: '#6BA8FF',
  overlay: 'rgba(6, 9, 20, 0.72)',
} as const;

/** Rarity → accent colour, so a list is scannable at a glance. */
const rarityColors: Record<string, string> = {
  Common: '#97A0BE',
  Uncommon: '#6BA8FF',
  Rare: '#B98BFF',
  Epic: '#FFB454',
  Legendary: '#FF8A5C',
  Showcase: '#3DDC97',
  Promo: '#FF7BC1',
};

export function rarityColor(rarity: string | null | undefined): string {
  if (!rarity) return colors.textFaint;
  return rarityColors[rarity] ?? colors.textMuted;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 24,
  xxl: 32,
} as const;
