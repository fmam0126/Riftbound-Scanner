/**
 * Small reusable presentational pieces shared by the screens.
 */

import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { CardRecord, OwnedCard } from '../types.ts';
import { colors, fontSize, radius, rarityColor, spacing } from '../theme.ts';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const palette =
    variant === 'primary'
      ? { bg: colors.accent, fg: '#04150E', border: colors.accent }
      : variant === 'danger'
        ? { bg: 'transparent', fg: colors.danger, border: colors.danger }
        : variant === 'ghost'
          ? { bg: 'transparent', fg: colors.textMuted, border: 'transparent' }
          : { bg: colors.surfaceRaised, fg: colors.text, border: colors.border };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      <Text style={[styles.buttonText, { color: palette.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
    </View>
  );
}

export function Loading({ label }: { label?: string }): React.JSX.Element {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      {label !== undefined && <Text style={styles.loadingLabel}>{label}</Text>}
    </View>
  );
}

/**
 * One row in a card list.
 *
 * Shows the copy count when the card is owned, and the printing name only when
 * it differs from the card name — so alternate arts are distinguishable without
 * repeating the name on every ordinary row.
 *
 * Memoized on the props it renders. These lists scroll through hundreds of rows
 * that each hold a network image, so re-rendering every row whenever the
 * collection changes — which is after every scan — is the difference between a
 * smooth list and a visibly stuttering one.
 */
export const CardRow = React.memo(function CardRow({
  card,
  owned,
  onPress,
  onLongPress,
  trailing,
}: {
  card: CardRecord;
  owned?: OwnedCard;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Rendered after the copy count, e.g. an add button on the Browse tab. */
  trailing?: React.ReactNode;
}): React.JSX.Element {
  const showPrinting = card.printingName !== card.name;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        // `minWidth: 0` is what lets this row shrink. Without it a flex child
        // refuses to go narrower than its content, which shoves any trailing
        // sibling off the right edge of the screen — the cause of the "Add"
        // button being cut off on the Browse tab.
        styles.rowShrinkable,
        pressed && { backgroundColor: colors.surfaceRaised },
      ]}
    >
      <CardThumb card={card} />

      <View style={[styles.rowBody, styles.rowShrinkable]}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {card.name}
        </Text>
        <View style={styles.rowMetaLine}>
          <Text style={[styles.rowId, { color: rarityColor(card.rarity) }]}>{card.id}</Text>
          {card.rarity !== null && <Text style={styles.rowMeta}>· {card.rarity}</Text>}
          {card.domain !== null && <Text style={styles.rowMeta}>· {card.domain}</Text>}
        </View>
        {showPrinting && (
          <Text style={styles.rowPrinting} numberOfLines={1}>
            {card.printingName}
          </Text>
        )}
      </View>

      {owned !== undefined && (
        <View style={styles.copies}>
          <Text style={styles.copiesCount}>{owned.copies}</Text>
          <Text style={styles.copiesLabel}>{owned.copies === 1 ? 'copy' : 'copies'}</Text>
        </View>
      )}

      {trailing}
    </Pressable>
  );
});

function CardThumb({ card }: { card: CardRecord }): React.JSX.Element {
  if (card.imageUrl === null) {
    return <View style={[styles.thumb, styles.thumbFallback]} />;
  }
  return (
    <Image
      source={{ uri: card.imageUrl }}
      style={styles.thumb}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
    />
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyMessage: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  rowShrinkable: {
    // Allows the row and its text column to shrink below their content width,
    // so a trailing control always stays on screen.
    flexShrink: 1,
    minWidth: 0,
  },
  thumb: {
    width: 44,
    height: 62,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
  },
  thumbFallback: {
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  rowId: {
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  rowMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  rowPrinting: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
  },
  copies: {
    alignItems: 'center',
    minWidth: 44,
  },
  copiesCount: {
    color: colors.accent,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  copiesLabel: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
  },
});
