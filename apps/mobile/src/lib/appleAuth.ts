type ClerkSetActive = (params: { session: string }) => Promise<unknown>;

type ClerkSignIn = {
  create: (params: { strategy: "oauth_token_apple"; token: string }) => Promise<unknown>;
  createdSessionId?: string | null;
  firstFactorVerification?: { status?: string | null } | null;
};

type ClerkSignUp = {
  create: (params: {
    transfer: true;
    unsafeMetadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  createdSessionId?: string | null;
};

type StartAppleAuthParams = {
  signIn: ClerkSignIn | undefined | null;
  signUp: ClerkSignUp | undefined | null;
  setActive?: ClerkSetActive;
  isSignInLoaded: boolean;
  isSignUpLoaded: boolean;
  unsafeMetadata?: Record<string, unknown>;
};

export type AppleAuthResult = {
  createdSessionId: string | null;
  setActive?: ClerkSetActive;
  signIn?: ClerkSignIn | null;
  signUp?: ClerkSignUp | null;
};

function isAppleAuthCanceled(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_REQUEST_CANCELED"
  );
}

export async function startAppleAuthenticationWithoutProfileScopes({
  signIn,
  signUp,
  setActive,
  isSignInLoaded,
  isSignUpLoaded,
  unsafeMetadata,
}: StartAppleAuthParams): Promise<AppleAuthResult> {
  if (!isSignInLoaded || !isSignUpLoaded || !signIn || !signUp) {
    return {
      createdSessionId: null,
      signIn,
      signUp,
      setActive,
    };
  }

  const [AppleAuthentication, Crypto] = await Promise.all([
    import("expo-apple-authentication"),
    import("expo-crypto"),
  ]);

  const isAvailable = await AppleAuthentication.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Apple Authentication is not available on this device.");
  }

  try {
    const nonce = Crypto.randomUUID();
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [],
      nonce,
    });

    if (!credential.identityToken) {
      throw new Error("No identity token received from Apple Sign-In.");
    }

    await signIn.create({
      strategy: "oauth_token_apple",
      token: credential.identityToken,
    });

    const userNeedsToBeCreated =
      signIn.firstFactorVerification?.status === "transferable";

    if (userNeedsToBeCreated) {
      await signUp.create({
        transfer: true,
        unsafeMetadata,
      });

      return {
        createdSessionId: signUp.createdSessionId ?? null,
        setActive,
        signIn,
        signUp,
      };
    }

    return {
      createdSessionId: signIn.createdSessionId ?? null,
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
