/**
 * Browse screen: the full card database, searchable.
 *
 * Doubles as the manual entry path. If a card's number is damaged, obscured, or
 * simply will not read, the user can find it here and add it by hand — which
 * matters because no scanner is ever 100% reliable.
 *
 * The database holds ~1400 cards, each row carrying a network thumbnail. Two
 * things keep this list responsive:
 *
 *   1. **Paging.** Only a window of results is held in state, grown as the user
 *      scrolls, rather than handing the whole set to `FlatList` at once. This is
 *      what stops the initial render from firing hundreds of simultaneous image
 *      requests.
 *   2. **A pre-built search index** (`src/data/cards.ts`), so filtering does not
 *      re-lowercase every card on each keystroke.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { countSearchMatches, getDatabase, searchCards } from '../data/cards.ts';
import { useCollection } from '../state/CollectionProvider.tsx';
import { CardRow, EmptyState } from '../components/ui.tsx';
import { colors, fontSize, radius, spacing } from '../theme.ts';

/** How many rows to add each time the user reaches the end of the list. */
const PAGE_SIZE = 40;
/** Delay before a keystroke is searched, so typing stays smooth. */
const SEARCH_DEBOUNCE_MS = 120;

export function BrowseScreen(): React.JSX.Element {
  const db = getDatabase();
  const { collection, recordScan } = useCollection();
  const [query, setQuery] = useState('');
  const [setCode, setSetCode] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Debounce so each keystroke does not trigger a full search pass. The input
  // stays responsive because its value is not derived from the search.
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // A new filter starts a new list, so reset paging whenever it changes.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [searchTerm, setCode]);

  const total = useMemo(
    () => countSearchMatches(searchTerm, { setCode }),
    [searchTerm, setCode],
  );

  const results = useMemo(
    () => searchCards(searchTerm, { setCode, limit }),
    [searchTerm, setCode, limit],
  );

  const hasMore = results.length < total;

  const addCard = useCallback(
    (card: CardRecord) => {
      recordScan(card);
    },
    [recordScan],
  );

  const loadMore = useCallback(() => {
    setLimit((current) => (current < total ? current + PAGE_SIZE : current));
  }, [total]);

  /**
   * Rendered through `CardRow`'s `trailing` slot rather than wrapped in another
   * `View`. The row already lays out horizontally and owns the side padding, so
   * appending here keeps the button on screen on narrow devices — wrapping it
   * previously let the row's content push the button past the right edge.
   */
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<CardRecord>) => {
      const owned = collection.owned[item.key];
      return (
        <CardRow
          card={item}
          owned={owned}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={owned === undefined ? `Add ${item.name}` : `Add another ${item.name}`}
              onPress={() => addCard(item)}
              style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
            >
              <Text style={styles.addButtonText}>{owned === undefined ? 'Add' : '+'}</Text>
            </Pressable>
          }
        />
      );
    },
    [addCard, collection.owned],
  );

  const keyExtractor = useCallback((card: CardRecord) => card.key, []);

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <TextInput
          style={styles.search}
          placeholder="Search name or number, e.g. Legion or OGN-010"
          placeholderTextColor={colors.textFaint}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip
            label={`All (${db.cards.length})`}
            active={setCode === null}
            onPress={() => setSetCode(null)}
          />
          {db.sets
            .filter((set) => set.cardCount > 0)
            .map((set) => (
              <Chip
                key={set.code}
                label={`${set.code} (${set.cardCount})`}
                active={setCode === set.code}
                onPress={() => setSetCode((current) => (current === set.code ? null : set.code))}
              />
            ))}
        </ScrollView>

        <Text style={styles.resultCount}>
          {results.length} of {total} cards
          {hasMore ? ' · scroll for more' : ''}
        </Text>
      </View>

      {results.length === 0 ? (
        <EmptyState
          title="No cards found"
          message={
            searchTerm.length > 0
              ? `Nothing matches "${searchTerm}". Try a card name or a printed number like OGN-010.`
              : 'No cards in this set yet.'
          }
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          // Render a small first window and batch the rest in, so the initial
          // paint is not blocked by hundreds of thumbnails loading at once.
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={50}
          windowSize={7}
          removeClippedSubviews
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={0.6}
          ListFooterComponent={
            hasMore ? (
              <View style={styles.footer}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.footerText}>Loading more…</Text>
              </View>
            ) : null
          }
        />
      )}
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
  header: {
    gap: spacing.sm,
    paddingTop: spacing.md,
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
  resultCount: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.lg,
  },
  listContent: {
    paddingVertical: spacing.sm,
  },
  addButton: {
    minWidth: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  addButtonPressed: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDark,
  },
  addButtonText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  footer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  footerText: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
  },
});
