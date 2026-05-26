import * as SecureStore from "expo-secure-store";

const memoryTokenCache = new Map<string, string>();

function isMissingEntitlementError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("required entitlement") ||
    message.includes("getValueWithKeyAsync") ||
    message.includes("setValueWithKeyAsync")
  );
}

export const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      if (isMissingEntitlementError(error)) {
        return memoryTokenCache.get(key) ?? null;
      }

      throw error;
    }
  },
  async saveToken(key: string, value: string) {
    memoryTokenCache.set(key, value);

    try {
      return await SecureStore.setItemAsync(key, value);
    } catch (error) {
      if (isMissingEntitlementError(error)) {
        return;
      }

      throw error;
    }
  },
};
