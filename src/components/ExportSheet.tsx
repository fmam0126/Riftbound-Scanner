/**
 * The export sheet.
 *
 * Presents the two formats, previews what will be written, and offers the three
 * delivery routes. It is purely presentational: every piece of state and every
 * native call lives in `ExportProvider`, so this file only decides what the user
 * sees.
 *
 * Long-press the preview to read the whole file. The preview is capped because
 * the contents can be 1400 lines and mounting that as `Text` would stutter the
 * modal on open, but a user checking what is about to leave the device should
 * still be able to see all of it.
 */

import React, { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { EXPORT_FORMATS } from '../logic/exportCollection.ts';
import { useExportSession } from '../export/ExportProvider.tsx';
import { Button } from './ui.tsx';
import { colors, fontSize, radius, spacing } from '../theme.ts';

/** Lines shown before the preview is collapsed. */
const PREVIEW_LINES = 10;

export function ExportSheet(): React.JSX.Element | null {
  const {
    open,
    format,
    setFormat,
    contents,
    summary,
    fileName,
    busy,
    message,
    failed,
    close,
    run,
  } = useExportSession();

  const [expanded, setExpanded] = useState(false);

  /**
   * Closes only when idle.
   *
   * Dismissing mid-delivery would leave the share sheet or the folder picker to
   * open over a screen the user has already moved on from, and the completion
   * message would land nowhere.
   */
  const handleClose = useCallback(() => {
    if (busy) return;
    setExpanded(false);
    close();
  }, [busy, close]);

  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  if (!open) return null;

  const lines = contents.length === 0 ? [] : contents.split('\n');
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - visible.length;

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      {/* Tapping the dimmed backdrop dismisses, which is the gesture users
          expect from a sheet. The inner Pressable stops the tap from reaching
          the backdrop when a drag or a button press happens inside. */}
      <Pressable style={styles.backdrop} onPress={handleClose} accessibilityRole="button">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.grabber} />

          <Text style={styles.title}>Export collection</Text>
          <Text style={styles.summary}>{summary}</Text>

          <View style={styles.formatRow}>
            {EXPORT_FORMATS.map((option) => {
              const active = option.format === format;
              return (
                <Pressable
                  key={option.format}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => setFormat(option.format)}
                  style={[styles.formatCard, active && styles.formatCardActive]}
                >
                  <Text style={[styles.formatLabel, active && styles.formatLabelActive]}>
                    {option.label}
                  </Text>
                  <Text style={styles.formatDescription}>{option.description}</Text>
                </Pressable>
              );
            })}
          </View>

          {lines.length > 0 && (
            <Pressable onPress={toggleExpanded} accessibilityRole="button">
              <View style={styles.previewHeader}>
                <Text style={styles.previewTitle}>{fileName}</Text>
                <Text style={styles.previewToggle}>
                  {expanded ? 'Hide preview' : `Preview · tap to see all ${lines.length}`}
                </Text>
              </View>

              <View style={styles.preview}>
                <ScrollView
                  style={styles.previewScroll}
                  contentContainerStyle={styles.previewContent}
                  // Nested in a vertical Modal, so the preview scrolls on its own
                  // and the sheet body stays put.
                  nestedScrollEnabled
                >
                  {visible.map((line, index) => (
                    <Text key={`${index}-${line}`} style={styles.previewLine}>
                      {line}
                    </Text>
                  ))}
                </ScrollView>
              </View>

              {hidden > 0 && (
                <Text style={styles.previewMore}>
                  …and {hidden} more {hidden === 1 ? 'line' : 'lines'}
                </Text>
              )}
            </Pressable>
          )}

          {message !== null && (
            <Text style={[styles.message, failed && styles.messageFailed]}>{message}</Text>
          )}

          <View style={styles.actions}>
            <Button
              label="Copy"
              variant="secondary"
              disabled={busy || contents.length === 0}
              onPress={() => void run('copy')}
              style={styles.action}
            />
            <Button
              label="Share"
              variant="secondary"
              disabled={busy || contents.length === 0}
              onPress={() => void run('share')}
              style={styles.action}
            />
            <Button
              label="Save"
              disabled={busy || contents.length === 0}
              onPress={() => void run('save')}
              style={styles.action}
            />
          </View>

          <Button
            label={busy ? 'Working…' : 'Done'}
            variant="ghost"
            disabled={busy}
            onPress={handleClose}
          />

          <Text style={styles.footnote}>
            Copy puts the file on the clipboard. Share sends it to another app. Save writes it
            to a folder you choose.
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    // Keeps the sheet from filling a tablet screen edge to edge.
    maxHeight: '90%',
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  summary: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: -spacing.sm,
  },
  formatRow: {
    gap: spacing.sm,
  },
  formatCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: spacing.md,
    gap: 2,
  },
  formatCardActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDark,
  },
  formatLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  formatLabelActive: {
    color: colors.accent,
  },
  formatDescription: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  previewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  previewTitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    flexShrink: 1,
  },
  previewToggle: {
    color: colors.info,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  preview: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  previewScroll: {
    maxHeight: 150,
  },
  previewContent: {
    gap: 1,
  },
  previewLine: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    // A monospaced face keeps the columns of a CSV roughly aligned, which is
    // what makes a preview worth reading at all.
    fontFamily: 'monospace',
  },
  previewMore: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  },
  message: {
    color: colors.accent,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  messageFailed: {
    color: colors.danger,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  action: {
    flex: 1,
    paddingHorizontal: spacing.sm,
  },
  footnote: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    lineHeight: 16,
  },
});
