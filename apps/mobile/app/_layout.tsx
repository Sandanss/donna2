import "../global.css";
import "@/src/i18n";
import { useEffect } from "react";
import { Stack, usePathname, useRouter, useSegments } from "expo-router";
import { ClerkProvider, ClerkLoaded, useAuth } from "@clerk/clerk-expo";
import { useQueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProfile } from "@/src/hooks/useProfile";
import { getErrorMessage } from "@/src/lib/api";
import { tokenCache } from "@/src/lib/auth";
import {
  registerForPushNotifications,
  addNotificationResponseListener,
} from "@/src/lib/notifications";
import {
  useFonts,
  PlayfairDisplay_400Regular,
  PlayfairDisplay_500Medium,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from "@expo-google-fonts/playfair-display";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { COLORS } from "@/src/constants/theme";
import { Button } from "@/src/components/ui";
import { ErrorBoundary } from "@/src/components/ErrorBoundary";
import { NetworkProvider } from "@/src/providers/NetworkProvider";
import { queryClient } from "@/src/lib/queryClient";
import { withErrorReporting } from "@/src/lib/errorReporting";
import {
  getProfileQueryKey,
  hasCompletedOnboarding,
  resolvePostAuthRoute,
} from "@/src/lib/profileSession";
import { getClerkPublishableKey } from "@/src/lib/runtimeConfig";

SplashScreen.preventAutoHideAsync();

function AuthGuard() {
  const { isLoaded, isSignedIn, signOut, userId } = useAuth();
  const { data: profile, isLoading: profileLoading, isError: profileError, error: profileErrorObj } = useProfile();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isLoaded) return;

    const firstSegment = segments?.[0];
    const inTabsGroup = firstSegment === "(tabs)";
    const inAuthGroup = firstSegment === "(auth)";
    const isLanding = pathname === "/";
    const nextRoute = resolvePostAuthRoute({
      profile,
      error: profileError ? profileErrorObj : undefined,
    });

    console.log(`[AuthGuard]`, JSON.stringify({
      isSignedIn, pathname, firstSegment, profileLoading, profileError: !!profileError,
      nextRoute, hasSeniors: profile?.seniors?.length ?? 0,
    }));

    if (!isSignedIn && inTabsGroup) {
      console.log(`[AuthGuard] Not signed in but in tabs → redirect to /`);
      router.replace("/");
    } else if (isSignedIn && (isLanding || inAuthGroup)) {
      if (!profileLoading && nextRoute) {
        console.log(`[AuthGuard] Signed in + auth area → navigating to ${nextRoute}`);
        router.replace(nextRoute as any);
      } else {
        console.log(`[AuthGuard] Signed in + auth area but waiting (profileLoading=${profileLoading}, nextRoute=${nextRoute})`);
      }
    } else if (
      isSignedIn &&
      inTabsGroup &&
      !profileLoading &&
      !profileError &&
      !hasCompletedOnboarding(profile)
    ) {
      router.replace("/(onboarding)/step1" as any);
    }
  }, [isLoaded, isSignedIn, pathname, segments, profile, profileLoading, profileError, profileErrorObj, router]);

  // Register for push notifications once the user is signed in
  useEffect(() => {
    if (!isSignedIn) return;

    registerForPushNotifications().then((token) => {
      if (token) {
        // TODO: Send token to backend when endpoint exists
        // api.notifications.registerPushToken(token);
      }
    });

    // Handle notification tap — navigate to relevant screen
    const subscription = addNotificationResponseListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.type === "call_summary") {
        router.push("/(tabs)");
      } else if (data?.type === "missed_call") {
        router.push("/(tabs)/schedule");
      }
    });

    return () => subscription.remove();
  }, [isSignedIn]);

  const firstSegment = segments?.[0];
  const inAuthBootstrap = pathname === "/" || firstSegment === "(auth)";
  const bootstrapRoute = resolvePostAuthRoute({
    profile,
    error: profileError ? profileErrorObj : undefined,
  });
  const showBootstrapError =
    isLoaded &&
    isSignedIn &&
    inAuthBootstrap &&
    !profileLoading &&
    profileError &&
    !bootstrapRoute;

  if (!isLoaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: COLORS.cream,
        }}
      >
        <ActivityIndicator size="large" color={COLORS.sage} />
      </View>
    );
  }

  if (showBootstrapError) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 24,
          backgroundColor: COLORS.cream,
        }}
      >
        <View style={{ width: "100%", maxWidth: 360 }}>
          <Text
            style={{
              fontSize: 28,
              lineHeight: 34,
              fontWeight: "600",
              color: COLORS.charcoal,
              textAlign: "center",
            }}
          >
            We couldn't load your Donna profile
          </Text>
          <Text
            style={{
              marginTop: 12,
              fontSize: 15,
              lineHeight: 22,
              color: COLORS.muted,
              textAlign: "center",
            }}
          >
            {getErrorMessage(
              profileErrorObj,
              "Please try again in a moment.",
              "auth",
            )}
          </Text>
          <Button
            title="Try Again"
            className="mt-6"
            onPress={() => {
              void queryClient.invalidateQueries({
                queryKey: getProfileQueryKey(userId),
              });
            }}
          />
          <Button
            title="Use a different sign-in method"
            variant="secondary"
            className="mt-3"
            onPress={async () => {
              queryClient.removeQueries({ queryKey: ["profile"] });
              await signOut();
              router.replace("/(auth)/sign-in" as any);
            }}
          />
        </View>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlayfairDisplay_400Regular,
    PlayfairDisplay_500Medium,
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  let clerkKey: string;
  try {
    clerkKey = getClerkPublishableKey();
  } catch (error) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 24,
          backgroundColor: COLORS.cream,
        }}
      >
        <View style={{ width: "100%", maxWidth: 360 }}>
          <Text
            style={{
              fontSize: 28,
              lineHeight: 34,
              fontWeight: "600",
              color: COLORS.charcoal,
              textAlign: "center",
            }}
          >
            Donna is missing mobile auth configuration
          </Text>
          <Text
            style={{
              marginTop: 12,
              fontSize: 15,
              lineHeight: 22,
              color: COLORS.muted,
              textAlign: "center",
            }}
          >
            {error instanceof Error ? error.message : "Set the public Clerk key for this build and relaunch the app."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <ClerkProvider publishableKey={clerkKey} tokenCache={tokenCache}>
        <ClerkLoaded>
          <QueryClientProvider client={queryClient}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <SafeAreaProvider>
                <NetworkProvider>
                  <StatusBar style="dark" />
                  <AuthGuard />
                </NetworkProvider>
              </SafeAreaProvider>
            </GestureHandlerRootView>
          </QueryClientProvider>
        </ClerkLoaded>
      </ClerkProvider>
    </ErrorBoundary>
  );
}

export default withErrorReporting(RootLayout);
