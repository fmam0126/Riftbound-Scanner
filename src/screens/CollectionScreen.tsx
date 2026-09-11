/**
 * Collection screen: what the user owns, with progress per set.
 *
 * Rows are long-pressable to remove a copy, which is the only way to correct a
 * mistake that was already confirmed (undo only covers the most recent scan).
 *
 * The header action opens the export sheet. That sheet's state lives in
 * `ExportProvider`, which is also what the **Export** tab drives, so both
 * entry points open the same sheet.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import type { CardRecord } from '../types.ts';
import {
  computeStats,
  defaultFilter,
  selectRows,
  type CollectionFilter,
  type CollectionRow,
  type CollectionSort,
} from '../state/collection.ts';
import { getDatabase } from '../data/cards.ts';
import { useCollection } from '../state/CollectionProvider.tsx';
import { useExportSession } from '../export/ExportProvider.tsx';
import { Button, CardRow, EmptyState, Loading } from '../components/ui.tsx';
import { colors, fontSize, radius, spacing } from '../theme.ts';

const SORTS: Array<{ key: CollectionSort; label: string }> = [
  { key: 'number', label: 'Number' },
  { key: 'name', label: 'Name' },
  { key: 'recent', label: 'Recent' },
  { key: 'copies', label: 'Copies' },
];

export function CollectionScreen(): React.JSX.Element {
  const { collection, loading, removeCopies } = useCollection();
  const { start: startExport } = useExportSession();
  const [filter, setFilter] = useState<CollectionFilter>(defaultFilter);
  const db = getDatabase();

  // Debounce the text filter so each keystroke does not re-filter and re-sort the
  // whole collection. The input keeps its own immediate value, so typing stays
  // responsive regardless of collection size.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filter.query), 120);
    return () => clearTimeout(timer);
  }, [filter.query]);

  const effectiveFilter = useMemo<CollectionFilter>(
    () => ({ ...filter, query: debouncedQuery }),
    [filter, debouncedQuery],
  );

  const stats = useMemo(() => computeStats(collection, db), [collection, db]);
  const rows = useMemo(
    () => selectRows(collection, db, effectiveFilter),
    [collection, db, effectiveFilter],
  );

  const handleRemove = useCallback(
    (card: CardRecord) => {
      const owned = collection.owned[card.key];
      if (owned === undefined) return;

      Alert.alert(
        card.name,
        owned.copies > 1
          ? `Remove one copy? You own ${owned.copies}.`
          : 'Remove this card from your collection?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => removeCopies(card.key, 1),
          },
        ],
      );
    },
    [collection.owned, removeCopies],
  );

  /**
   * Stable across renders as long as the collection does not change, so scrolling
   * does not re-render every visible row. `CardRow` is memoized, so keeping these
   * identities steady is what makes that memoization actually pay off.
   */
  const keyExtractor = useCallback((row: CollectionRow) => row.card.key, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<CollectionRow>) => (
      <CardRow
        card={item.card}
        owned={item.owned}
        onLongPress={() => handleRemove(item.card)}
      />
    ),
    [handleRemove],
  );

  if (loading) return <Loading label="Loading your collection…" />;

  return (
    <View style={styles.fill}>
      <View style={styles.statsBar}>
        <Stat label="Unique" value={`${stats.uniqueOwned}`} />
        <Stat label="Copies" value={`${stats.totalCopies}`} />
        <Stat
          label="Complete"
          value={`${(stats.completion * 100).toFixed(1)}%`}
          hint={`of ${stats.totalCards}`}
        />
      </View>

      {/* Disabled rather than hidden when there is nothing to export, so the
          action is discoverable before the first scan. */}
      <Button
        label="Export collection"
        variant="secondary"
        disabled={stats.uniqueOwned === 0}
        onPress={startExport}
        style={styles.exportButton}
      />

      <View style={styles.filters}>
        <TextInput
          style={styles.search}
          placeholder="Filter by name or number"
          placeholderTextColor={colors.textFaint}
          value={filter.query}
          onChangeText={(query) => setFilter((f) => ({ ...f, query }))}
          autoCorrect={false}
          autoCapitalize="characters"
          returnKeyType="search"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip
            label="All sets"
            active={filter.setCode === null}
            onPress={() => setFilter((f) => ({ ...f, setCode: null }))}
          />
          {db.sets
            .filter((set) => (stats.perSet[set.code] ?? 0) > 0)
            .map((set) => (
              <Chip
                key={set.code}
                label={`${set.code} ${stats.perSet[set.code] ?? 0}/${set.cardCount}`}
                active={filter.setCode === set.code}
                onPress={() =>
                  setFilter((f) => ({
                    ...f,
                    setCode: f.setCode === set.code ? null : set.code,
                  }))
                }
              />
            ))}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {SORTS.map((sort) => (
            <Chip
              key={sort.key}
              label={sort.label}
              active={filter.sort === sort.key}
              onPress={() => setFilter((f) => ({ ...f, sort: sort.key }))}
            />
          ))}
          <Chip
            label="Duplicates"
            active={filter.duplicatesOnly}
            onPress={() => setFilter((f) => ({ ...f, duplicatesOnly: !f.duplicatesOnly }))}
          />
        </ScrollView>
      </View>

      {rows.length === 0 ? (
        <EmptyState
          title={stats.uniqueOwned === 0 ? 'Nothing scanned yet' : 'No cards match'}
          message={
            stats.uniqueOwned === 0
              ? 'Head to the Scan tab and point the camera at the number at the bottom of a card.'
              : 'Try clearing the filter or searching for a different card.'
          }
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          // Render a small first window and stream the rest in. The collection
          // can hold the whole set (~1400 rows), each with a network thumbnail,
          // so painting everything before the first frame is what made this list
          // feel slow to open.
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          windowSize={7}
          removeClippedSubviews
        />
      )}
    </View>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {hint !== undefined && <Text style={styles.statHint}>{hint}</Text>}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.background,
  },
  statsBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.lg,
  },
  exportButton: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
  },
  stat: {
    flex: 1,
  },
  statValue: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statHint: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
  },
  filters: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  search: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipRow: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipActive: {
    backgroundColor: colors.accentDark,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.accent,
  },
  listContent: {
    paddingVertical: spacing.sm,
  },
});
