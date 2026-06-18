import type { PlatformId } from './platform';

export interface RemoteConfigAppliedRule {
  platformIds: PlatformId[];
  reason?: string | null;
}

export interface RemoteConfigState {
  version: string;
  updatedAt: number;
  currentOs: string;
  hiddenPlatformIds: PlatformId[];
  appliedRules: RemoteConfigAppliedRule[];
  refreshIntervalMs: number;
}
