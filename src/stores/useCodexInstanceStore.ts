import * as codexInstanceService from '../services/codexInstanceService';
import type {
  CodexSessionVisibilityRepairInstanceList,
  CodexSessionVisibilityRepairProviderList,
  CodexSessionVisibilityRepairRequestOptions,
  CodexSessionVisibilityRepairSummary,
  CodexInstanceThreadSyncSummary,
  CodexInstanceTargetThreadSyncSummary,
  CodexSessionRecord,
  CodexSessionSearchOptions,
  CodexSessionTokenStats,
  CodexSessionTrashSummary,
  CodexTrashedSessionRecord,
  CodexSessionRestoreSummary,
} from '../types/codex';
import { createInstanceStore, type InstanceStoreState } from './createInstanceStore';

type CodexInstanceStoreState = InstanceStoreState & {
  syncThreadsAcrossInstances: () => Promise<CodexInstanceThreadSyncSummary>;
  syncSessionsToInstance: (
    sessionIds: string[],
    targetInstanceId: string,
  ) => Promise<CodexInstanceTargetThreadSyncSummary>;
  repairSessionVisibilityAcrossInstances: (
    runId?: string,
    options?: CodexSessionVisibilityRepairRequestOptions,
  ) => Promise<CodexSessionVisibilityRepairSummary>;
  listSessionVisibilityRepairInstances: () => Promise<CodexSessionVisibilityRepairInstanceList>;
  listSessionVisibilityRepairProviders: () => Promise<CodexSessionVisibilityRepairProviderList>;
  listSessionsAcrossInstances: (options?: CodexSessionSearchOptions) => Promise<CodexSessionRecord[]>;
  getSessionTokenStatsAcrossInstances: (sessionIds: string[]) => Promise<CodexSessionTokenStats[]>;
  moveSessionsToTrashAcrossInstances: (sessionIds: string[]) => Promise<CodexSessionTrashSummary>;
  listTrashedSessionsAcrossInstances: () => Promise<CodexTrashedSessionRecord[]>;
  restoreSessionsFromTrashAcrossInstances: (sessionIds: string[]) => Promise<CodexSessionRestoreSummary>;
};

type CodexInstanceStoreHook = {
  (): CodexInstanceStoreState;
  <T>(selector: (state: CodexInstanceStoreState) => T): T;
  getState: () => CodexInstanceStoreState;
  setState: (partial: Partial<CodexInstanceStoreState>) => void;
};

const baseStore = createInstanceStore(codexInstanceService, 'agtools.codex.instances.cache');
const typedBaseStore = baseStore as unknown as CodexInstanceStoreHook;

const syncThreadsAcrossInstances = async (): Promise<CodexInstanceThreadSyncSummary> => {
  const summary = await codexInstanceService.syncThreadsAcrossInstances();
  await typedBaseStore.getState().fetchInstances();
  return summary;
};

const syncSessionsToInstance = async (
  sessionIds: string[],
  targetInstanceId: string,
): Promise<CodexInstanceTargetThreadSyncSummary> => {
  const summary = await codexInstanceService.syncSessionsToInstance(sessionIds, targetInstanceId);
  await typedBaseStore.getState().fetchInstances();
  return summary;
};

const repairSessionVisibilityAcrossInstances = async (
  runId?: string,
  options?: CodexSessionVisibilityRepairRequestOptions,
): Promise<CodexSessionVisibilityRepairSummary> => {
  const summary = await codexInstanceService.repairSessionVisibilityAcrossInstances(runId, options);
  await typedBaseStore.getState().fetchInstances();
  return summary;
};

const listSessionVisibilityRepairProviders = async (): Promise<CodexSessionVisibilityRepairProviderList> => {
  return await codexInstanceService.listSessionVisibilityRepairProviders();
};

const listSessionVisibilityRepairInstances = async (): Promise<CodexSessionVisibilityRepairInstanceList> => {
  return await codexInstanceService.listSessionVisibilityRepairInstances();
};

const listSessionsAcrossInstances = async (
  options?: CodexSessionSearchOptions,
): Promise<CodexSessionRecord[]> => {
  return await codexInstanceService.listSessionsAcrossInstances(options);
};

const getSessionTokenStatsAcrossInstances = async (
  sessionIds: string[],
): Promise<CodexSessionTokenStats[]> => {
  return await codexInstanceService.getSessionTokenStatsAcrossInstances(sessionIds);
};

const moveSessionsToTrashAcrossInstances = async (
  sessionIds: string[],
): Promise<CodexSessionTrashSummary> => {
  const summary = await codexInstanceService.moveSessionsToTrashAcrossInstances(sessionIds);
  await typedBaseStore.getState().fetchInstances();
  return summary;
};

const listTrashedSessionsAcrossInstances = async (): Promise<CodexTrashedSessionRecord[]> => {
  return await codexInstanceService.listTrashedSessionsAcrossInstances();
};

const restoreSessionsFromTrashAcrossInstances = async (
  sessionIds: string[],
): Promise<CodexSessionRestoreSummary> => {
  const summary = await codexInstanceService.restoreSessionsFromTrashAcrossInstances(sessionIds);
  await typedBaseStore.getState().fetchInstances();
  return summary;
};

typedBaseStore.setState({
  syncThreadsAcrossInstances,
  syncSessionsToInstance,
  repairSessionVisibilityAcrossInstances,
  listSessionVisibilityRepairInstances,
  listSessionVisibilityRepairProviders,
  listSessionsAcrossInstances,
  getSessionTokenStatsAcrossInstances,
  moveSessionsToTrashAcrossInstances,
  listTrashedSessionsAcrossInstances,
  restoreSessionsFromTrashAcrossInstances,
});

export const useCodexInstanceStore = typedBaseStore;
