/**
 * Application root.
 *
 * Three tabs, with the scanner as the default destination since scanning is the
 * primary action. Navigation state is not persisted: re-opening the app on the
 * scanner is the expected behaviour.
 */

import React from 'react';
import { NavigationContainer, DarkTheme, type Theme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CollectionProvider } from './state/CollectionProvider.tsx';
import { ScanScreen } from './screens/ScanScreen.tsx';
import { CollectionScreen } from './screens/CollectionScreen.tsx';
import { BrowseScreen } from './screens/BrowseScreen.tsx';
import { colors, fontSize } from './theme.ts';

/** Route names for the bottom tabs. Used only here. */
type RootTabs = {
  Scan: undefined;
  Collection: undefined;
  Browse: undefined;
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
          </Tab.Navigator>
        </NavigationContainer>
      </CollectionProvider>
    </SafeAreaProvider>
  );
}

/**
 * Text-based tab icon.
 *
 * Using glyphs avoids pulling in an icon font for three symbols, and keeps the
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
