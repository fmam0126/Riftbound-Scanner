/**
 * Collection state shared across screens.
 *
 * A reducer holds the authoritative collection in memory and AsyncStorage
 * persists it. Scans mutate the in-memory state immediately so the UI responds
 * instantly, then the write is scheduled in the background — a card scanner is
 * used in bursts, and waiting on storage per scan would feel sluggish.
 *
 * Every add returns an undo token, because OCR occasionally resolves to the
 * wrong printing and the user must be able to fix that without hunting through
 * the collection.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

import type { CardRecord, CollectionState } from '../types.ts';
import {
  addCard,
  clearCollection,
  emptyCollection,
  loadCollection,
  removeCard,
  saveCollection,
} from './collection.ts';

interface UndoEntry {
  /** Collection snapshot from before the add. */
  previous: CollectionState;
  cardKey: string;
  cardName: string;
  /** Distinguishes "added" from "added another copy" in the toast. */
  wasNew: boolean;
}

interface State {
  collection: CollectionState;
  /** True until the first read from storage completes. */
  loading: boolean;
  /** Most recent add, offered as an undo action in the UI. */
  lastAdd: UndoEntry | null;
  /** Copy count produced by the most recent add, surfaced to the scanner UI. */
  lastCopies: number | null;
}

type Action =
  | { type: 'loaded'; collection: CollectionState }
  | { type: 'add'; card: CardRecord; copies: number }
  | { type: 'undo' }
  | { type: 'remove'; key: string; copies: number }
  | { type: 'clear' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return { ...state, collection: action.collection, loading: false };
    case 'add': {
      const { state: next, newCopies, isNew } = addCard(
        state.collection,
        action.card,
        action.copies,
      );
      return {
        ...state,
        collection: next,
        lastCopies: newCopies,
        lastAdd: {
          previous: state.collection,
          cardKey: action.card.key,
          cardName: `${action.card.name} (${action.card.id})`,
          wasNew: isNew,
        },
      };
    }
    case 'undo':
      if (state.lastAdd === null) return state;
      return { ...state, collection: state.lastAdd.previous, lastAdd: null, lastCopies: null };
    case 'remove':
      return {
        ...state,
        collection: removeCard(state.collection, action.key, action.copies),
        lastAdd: null,
        lastCopies: null,
      };
    case 'clear':
      return { collection: emptyCollection(), loading: false, lastAdd: null, lastCopies: null };
    default:
      return state;
  }
}

interface CollectionContextValue {
  collection: CollectionState;
  loading: boolean;
  lastAdd: UndoEntry | null;
  /** Copy count from the most recent add, or null when there has not been one. */
  lastCopies: number | null;
  recordScan: (card: CardRecord, copies?: number) => void;
  undoLastAdd: () => void;
  removeCopies: (key: string, copies?: number) => void;
  resetCollection: () => Promise<void>;
}

const CollectionContext = createContext<CollectionContextValue | null>(null);

export function CollectionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, {
    collection: emptyCollection(),
    loading: true,
    lastAdd: null,
    lastCopies: null,
  });

  // Guards against writing the empty initial state over real stored data before
  // the first load resolves.
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collection = await loadCollection();
      if (cancelled) return;
      hydrated.current = true;
      dispatch({ type: 'loaded', collection });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    void saveCollection(state.collection);
  }, [state.collection]);

  const recordScan = useCallback((card: CardRecord, copies = 1) => {
    dispatch({ type: 'add', card, copies });
  }, []);

  const undoLastAdd = useCallback(() => dispatch({ type: 'undo' }), []);
  const removeCopies = useCallback(
    (key: string, copies = 1) => dispatch({ type: 'remove', key, copies }),
    [],
  );

  const resetCollection = useCallback(async () => {
    await clearCollection();
    dispatch({ type: 'clear' });
  }, []);

  const value = useMemo<CollectionContextValue>(
    () => ({
      collection: state.collection,
      loading: state.loading,
      lastAdd: state.lastAdd,
      lastCopies: state.lastCopies,
      recordScan,
      undoLastAdd,
      removeCopies,
      resetCollection,
    }),
    // Depends on the individual state fields rather than the whole state object,
    // so the context value is not rebuilt by unrelated re-renders.
    [
      state.collection,
      state.loading,
      state.lastAdd,
      state.lastCopies,
      recordScan,
      undoLastAdd,
      removeCopies,
      resetCollection,
    ],
  );

  return <CollectionContext.Provider value={value}>{children}</CollectionContext.Provider>;
}

export function useCollection(): CollectionContextValue {
  const value = useContext(CollectionContext);
  if (value === null) {
    throw new Error('useCollection must be used inside a CollectionProvider');
  }
  return value;
}
