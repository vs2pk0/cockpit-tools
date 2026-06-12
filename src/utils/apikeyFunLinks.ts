export type CodexProviderWireApi = "responses" | "chat_completions";

export const APIKEY_FUN_PROVIDER_BASE_URL = 'https://api.apikey.fun';

export function buildApiKeyFunProviderBaseUrl(endpoint: string): string {
  return `${APIKEY_FUN_PROVIDER_BASE_URL}${endpoint}`;
}

export function normalizeApiKeyFunOfficialUrl(value?: string | null): string {
  return value?.trim() || APIKEY_FUN_PROVIDER_BASE_URL;
}

export function isApiKeyFunProviderBaseUrl(value?: string | null): boolean {
  if (!value) return false;
  return value.includes('apikey.fun');
}

export function resolveApiKeyFunWireApi(
  baseUrl?: string | null,
  wireApi?: string | null,
): CodexProviderWireApi | null {
  return isApiKeyFunProviderBaseUrl(baseUrl) ? 'responses' : wireApi as CodexProviderWireApi ?? null;
}
