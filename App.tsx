import React from "react";
import {
  View,
  Image,
  StyleSheet,
  TouchableOpacity,
  Text,
} from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  createBottomTabNavigator,
  type BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  MessageCircle,
  Users,
  Phone,
  CircleUserRound,
} from "lucide-react-native";
import { AuthProvider, useAuth } from "./src/lib/auth";
import "./src/lib/media"; // registers the media uploader with the sync engine
import "./src/lib/e2ee"; // registers the E2EE hooks with the sync engine
import { LoginScreen } from "./src/screens/LoginScreen";
import { RegisterScreen } from "./src/screens/RegisterScreen";
import { ChatsScreen } from "./src/screens/ChatsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { PeopleScreen } from "./src/screens/PeopleScreen";
import { CallsScreen } from "./src/screens/CallsScreen";
import { YouScreen } from "./src/screens/YouScreen";
import { ScreenHead } from "./src/components/ScreenHead";
import { CallOverlay } from "./src/components/CallOverlay";
import { CrashGuard } from "./src/components/CrashGuard";
import { ChatHeader } from "./src/components/ChatHeader";
import { colors, font } from "./src/theme";

const AuthStack = createNativeStackNavigator();
const ChatsStack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function ChatsStackNavigator() {
  return (
    <ChatsStack.Navigator>
      <ChatsStack.Screen
        name="Chats"
        component={ChatsScreen}
        options={{ header: () => <ScreenHead title="Chats" /> }}
      />
      <ChatsStack.Screen
        name="Chat"
        component={ChatScreen}
        options={{
          header: ({ route, navigation }: any) => (
            <ChatHeader route={route} navigation={navigation} />
          ),
        }}
      />
    </ChatsStack.Navigator>
  );
}

const TAB_DEFS = [
  { name: "ChatsTab", label: "Chats", Icon: MessageCircle },
  { name: "People", label: "People", Icon: Users },
  { name: "Calls", label: "Calls", Icon: Phone },
  { name: "You", label: "You", Icon: CircleUserRound },
];

// Web parity bottom bar: active tab gets the mint pill.
function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {state.routes.map((route, i) => {
        const def = TAB_DEFS.find((d) => d.name === route.name) ?? TAB_DEFS[i];
        const active = state.index === i;
        const Icon = def.Icon;
        return (
          <TouchableOpacity
            key={route.key}
            style={[styles.tabItem, active && styles.tabItemActive]}
            onPress={() => {
              // Standard tabPress flow so a tab can reset/scroll-to-top and
              // listeners can veto it.
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!active && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            }}
            activeOpacity={0.8}
          >
            <Icon
              size={21}
              color={active ? colors.greenDark : colors.navIdle}
              strokeWidth={active ? 2.4 : 2}
            />
            <Text
              style={[
                styles.tabLabel,
                { color: active ? colors.greenDark : colors.navIdle },
              ]}
            >
              {def.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen
        name="ChatsTab"
        component={ChatsStackNavigator}
        options={{ headerShown: false }}
      />
      <Tabs.Screen
        name="People"
        component={PeopleScreen}
        options={{ header: () => <ScreenHead title="People" /> }}
      />
      <Tabs.Screen
        name="Calls"
        component={CallsScreen}
        options={{ header: () => <ScreenHead title="Calls" /> }}
      />
      <Tabs.Screen
        name="You"
        component={YouScreen}
        options={{ header: () => <ScreenHead title="You" /> }}
      />
    </Tabs.Navigator>
  );
}

function Root() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <View style={styles.splash}>
        <Image
          source={require("./assets/logo-mark.png")}
          style={styles.splashLogo}
          resizeMode="contain"
        />
      </View>
    );
  }
  return (
    <NavigationContainer>
      {user ? (
        <>
          <MainTabs />
          <CallOverlay />
        </>
      ) : (
        <AuthStack.Navigator screenOptions={{ headerShown: false }}>
          <AuthStack.Screen name="Login" component={LoginScreen} />
          <AuthStack.Screen name="Register" component={RegisterScreen} />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <CrashGuard>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </CrashGuard>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  splashLogo: { width: 110, height: 110 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 10,
    paddingTop: 8,
    gap: 4,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingVertical: 6,
    borderRadius: 16,
  },
  tabItemActive: { backgroundColor: colors.mint },
  tabLabel: { fontFamily: font.bold, fontSize: 10 },
});
