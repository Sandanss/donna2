import { useSignIn, useSignUp } from "@clerk/clerk-expo";

type AppleAuthenticationResult = {
  createdSessionId: string | null;
  setActive?: ReturnType<typeof useSignIn>["setActive"];
  signIn?: ReturnType<typeof useSignIn>["signIn"];
  signUp?: ReturnType<typeof useSignUp>["signUp"];
};

function isAppleAuthCanceled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_REQUEST_CANCELED"
  );
}

export function useAppleAuthenticationWithoutProfileScopes() {
  const { signIn, setActive, isLoaded: isSignInLoaded } = useSignIn();
  const { signUp, isLoaded: isSignUpLoaded } = useSignUp();

  async function startAppleAuthenticationFlow(): Promise<AppleAuthenticationResult> {
    if (!isSignInLoaded || !isSignUpLoaded || !signIn || !signUp) {
      return {
        createdSessionId: null,
        signIn,
        signUp,
        setActive,
      };
    }

    let AppleAuthentication: typeof import("expo-apple-authentication");
    let Crypto: typeof import("expo-crypto");

    try {
      [AppleAuthentication, Crypto] = await Promise.all([
        import("expo-apple-authentication"),
        import("expo-crypto"),
      ]);
    } catch {
      throw new Error(
        "expo-apple-authentication and expo-crypto are required to use Sign in with Apple.",
      );
    }

    const isAvailable = await AppleAuthentication.isAvailableAsync();
    if (!isAvailable) {
      throw new Error("Apple Authentication is not available on this device.");
    }

    try {
      const credential = await AppleAuthentication.signInAsync({
        // Donna's Apple flow must not request profile fields during sign-up.
        requestedScopes: [],
        nonce: Crypto.randomUUID(),
      });

      if (!credential.identityToken) {
        throw new Error("No identity token received from Apple Sign-In.");
      }

      await signIn.create({
        strategy: "oauth_token_apple",
        token: credential.identityToken,
      });

      if ((signIn.firstFactorVerification as any)?.status === "transferable") {
        await signUp.create({ transfer: true });

        return {
          createdSessionId: signUp.createdSessionId,
          setActive,
          signIn,
          signUp,
        };
      }

      return {
        createdSessionId: signIn.createdSessionId,
        setActive,
        signIn,
        signUp,
      };
    } catch (error) {
      if (isAppleAuthCanceled(error)) {
        return {
          createdSessionId: null,
          setActive,
          signIn,
          signUp,
        };
      }

      throw error;
    }
  }

  return { startAppleAuthenticationFlow };
}
