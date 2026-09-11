/**
 * Application root.
 *
 * Three tabs, with the scanner as the default destination since scanning is the
 * primary action. Navigation state is not persisted: re-opening the app on the
 * scanner is the expected behaviour.
 *
 * `ExportProvider` sits inside `CollectionProvider` because exporting reads the
 * collection, and outside the navigator because two things start an export: the
 * button in the collection header and the **Export** tab. Both open one shared
 * sheet whose state is the provider's, so they cannot end up showing two.
 */

import React from 'react';
import {
  NavigationContainer,
  DarkTheme,
  useNavigationState,
  type Theme,
} from '@react-navigation/native';
import { createBottomTabNavigator, type BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { StatusBar } from 'expo-status-bar';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CollectionProvider } from './state/CollectionProvider.tsx';
import { ExportProvider, useExportSession } from './export/ExportProvider.tsx';
import { ScanScreen } from './screens/ScanScreen.tsx';
import { CollectionScreen } from './screens/CollectionScreen.tsx';
import { BrowseScreen } from './screens/BrowseScreen.tsx';
import { ExportSheet } from './components/ExportSheet.tsx';
import { colors, fontSize } from './theme.ts';

/**
 * Route names for the bottom tabs. Used only here.
 *
 * `Export` is a tab so the feature is discoverable, but it has no screen of its
 * own — see {@link ExportTabButton}. Its component is never rendered, since the
 * press is always intercepted either to open the sheet directly or to hand the
 * press to the navigator.
 */
type RootTabs = {
  Scan: undefined;
  Collection: undefined;
  Browse: undefined;
  Export: undefined;
};

const Tab = createBottomTabNavigator<RootTabs>();

const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
    notification: colors.danger,
  },
};

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <CollectionProvider>
        <ExportProvider>
          <NavigationContainer theme={navigationTheme}>
            <StatusBar style="light" />
            <Tab.Navigator
              initialRouteName="Scan"
              screenOptions={{
                headerStyle: { backgroundColor: colors.surface },
                headerTitleStyle: { color: colors.text, fontWeight: '700' },
                headerTintColor: colors.text,
                tabBarStyle: {
                  backgroundColor: colors.surface,
                  borderTopColor: colors.border,
                },
                tabBarActiveTintColor: colors.accent,
                tabBarInactiveTintColor: colors.textFaint,
                tabBarLabelStyle: { fontSize: fontSize.xs, fontWeight: '600' },
              }}
            >
              <Tab.Screen
                name="Scan"
                component={ScanScreen}
                options={{
                  title: 'Scan',
                  headerShown: false,
                  tabBarIcon: ({ color }) => <TabGlyph glyph="◉" color={color} />,
                }}
              />
              <Tab.Screen
                name="Collection"
                component={CollectionScreen}
                options={{
                  title: 'Collection',
                  tabBarIcon: ({ color }) => <TabGlyph glyph="▤" color={color} />,
                }}
              />
              <Tab.Screen
                name="Browse"
                component={BrowseScreen}
                options={{
                  title: 'Browse',
                  tabBarIcon: ({ color }) => <TabGlyph glyph="⌕" color={color} />,
                }}
              />
              <Tab.Screen
                name="Export"
                component={CollectionScreen}
                options={{
                  title: 'Export',
                  tabBarIcon: ({ color }) => <TabGlyph glyph="⇪" color={color} />,
                  tabBarButton: (props) => <ExportTabButton {...props} />,
                }}
              />
            </Tab.Navigator>

            {/* Rendered as a sibling of the navigator so the sheet is not
                unmounted by a tab change while it is open. */}
            <ExportSheet />
          </NavigationContainer>
        </ExportProvider>
      </CollectionProvider>
    </SafeAreaProvider>
  );
}

/**
 * The Export tab.
 *
 * Behaving as a real tab is what makes the export discoverable, but the tab has
 * no screen of its own to show: it opens a sheet over whatever is already on
 * screen. So the press is intercepted — opening the sheet when the collection is
 * already visible, and otherwise letting the tab navigate to the collection
 * screen, which the sheet then sits over. Navigating first also means a user who
 * dismisses the sheet ends up somewhere sensible rather than back on Scan.
 */
function ExportTabButton(props: BottomTabBarButtonProps): React.JSX.Element {
  const { start } = useExportSession();
  const focusedName = useNavigationState((state) =>
    state === undefined ? null : (state.routes[state.index]?.name ?? null),
  );

  const { onPress: navigatorPress, ...rest } = props;

  return (
    <PlatformPressable
      {...rest}
      onPress={(event) => {
        if (focusedName === 'Collection') {
          start();
          return;
        }
        navigatorPress?.(event);
        // The navigator's own handler is the only way to select the tab, and it
        // is asynchronous, so the sheet is opened on the next frame to land over
        // the collection screen rather than the one being left.
        setTimeout(start, 0);
      }}
    />
  );
}

/**
 * Text-based tab icon.
 *
 * Using glyphs avoids pulling in an icon font for a few symbols, and keeps the
 * bundle smaller than an icon library would.
 */
function TabGlyph({ glyph, color }: { glyph: string; color: string }): React.JSX.Element {
  return (
    <View style={styles.glyphWrap}>
      <Text style={[styles.glyph, { color }]}>{glyph}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  glyphWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    fontSize: 20,
    lineHeight: 24,
  },
});
