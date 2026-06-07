import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bug,
  Check,
  CircleAlert,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FolderPlus,
  Gauge,
  KeyRound,
  Power,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { confirm as confirmDialog, open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import type { CodexAccount } from '../types/codex';
import type { CodexAccountGroup } from '../services/codexAccountGroupService';
import * as codexService from '../services/codexService';
import type { CodexCpaServiceState } from '../services/codexService';
import * as codexLocalAccessService from '../services/codexLocalAccessService';
import {
  CODEX_CPA_SERVICE_API_KEY,
  CODEX_CPA_SERVICE_BASE_URL,
} from '../types/codexLocalAccess';
import type {
  CodexLocalAccessCredentialMode,
  CodexLocalAccessCustomCredential,
  CodexLocalAccessCustomRoutingRule,
  CodexLocalAccessEndpointKind,
  CodexLocalAccessRoutingStrategy,
  CodexLocalAccessScope,
  CodexLocalAccessState,
  CodexLocalAccessStatsWindow,
  CodexLocalAccessTestResult,
  CodexLocalAccessUsageStats,
} from '../types/codexLocalAccess';
import {
  getCodexPlanFilterKey,
} from '../types/codex';
import {
  buildCodexAccountPresentation,
  buildQuotaPreviewLines,
} from '../presentation/platformAccountPresentation';
import { buildValidAccountsFilterOption, splitValidityFilterValues } from '../utils/accountValidityFilter';
import {
  formatCodexQuotaPoolPercent,
  summarizeCodexQuotaPool,
  type CodexQuotaPoolItem,
} from '../utils/codexQuotaPool';
import { isCodexLocalAccessEligibleAccount } from '../utils/codexLocalAccessAccounts';
import { isBlockingCodexQuotaError } from '../utils/codexQuotaError';
import { AccountTagFilterDropdown } from './AccountTagFilterDropdown';
import {
  CodexPlanBadge,
  type CodexPlanBadgeStylePreferences,
} from './codex/CodexPlanBadge';
import {
  MultiSelectFilterDropdown,
  type MultiSelectFilterOption,
} from './MultiSelectFilterDropdown';
import { SingleSelectDropdown } from './SingleSelectDropdown';
import { useEscClose } from '../hooks/useEscClose';
import './GroupAccountPickerModal.css';
import './CodexLocalAccessModal.css';

interface CodexLocalAccessModalProps {
  isOpen: boolean;
  mode: 'panel' | 'members';
  state: CodexLocalAccessState | null;
  addressKind: CodexLocalAccessEndpointKind;
  addressOptions: Array<{ value: string; label: string }>;
  onAddressKindChange: (value: string) => Promise<void> | void;
  accounts: CodexAccount[];
  accountGroups: CodexAccountGroup[];
  initialSelectedIds: string[];
  maskAccountText: (value?: string | null) => string;
  onClose: () => void;
  onOpenFullPage?: () => void;
  onSaveAccounts: (payload: {
    accountIds: string[];
    restrictFreeAccounts: boolean;
  }) => Promise<unknown> | unknown;
  onClearStats: () => Promise<unknown> | unknown;
  onRefreshStats: () => Promise<unknown> | unknown;
  onUpdatePort: (port: number) => Promise<unknown> | unknown;
  onUpdateRoutingStrategy: (
    strategy: CodexLocalAccessRoutingStrategy,
  ) => Promise<unknown> | unknown;
  onUpdateCustomRouting: (
    rules: CodexLocalAccessCustomRoutingRule[],
  ) => Promise<unknown> | unknown;
  onUpdateAccessScope: (
    accessScope: CodexLocalAccessScope,
  ) => Promise<unknown> | unknown;
  onUpdateCredentials: (payload: {
    credentialMode: CodexLocalAccessCredentialMode;
    activeCustomCredentialId?: string | null;
    customCredentials?: CodexLocalAccessCustomCredential[] | null;
    customBaseUrl?: string | null;
    customApiKey?: string | null;
    ensureCpaService?: boolean;
  }) => Promise<unknown> | unknown;
  onUpdateUpstreamProxyConfig: (
    upstreamProxyUrl: string | null,
  ) => Promise<unknown> | unknown;
  onUpdateDebugLogs: (debugLogs: boolean) => Promise<unknown> | unknown;
  onRotateApiKey: () => Promise<unknown> | unknown;
  onKillPort: () => Promise<unknown> | unknown;
  onToggleEnabled: () => Promise<unknown> | unknown;
  onTest: () => Promise<CodexLocalAccessTestResult> | CodexLocalAccessTestResult;
  planBadgeStylePreferences: CodexPlanBadgeStylePreferences;
  saving: boolean;
  testing: boolean;
  starting: boolean;
  portCleanupBusy: boolean;
}

type StatsRangeKey = 'daily' | 'weekly' | 'monthly';
type CopyableField = 'apiPortUrl' | 'baseUrl' | 'apiKey' | 'modelId';
type CodexLocalAccessCollectionState = NonNullable<CodexLocalAccessState['collection']>;

interface CustomRoutingDraftRule {
  priority: number;
  weight: number;
}

const CODEX_LOCAL_ACCESS_STATS_RANGE_STORAGE_KEY =
  'agtools.codex.local_access.stats_range.v1';
const CUSTOM_ROUTING_PRIORITY_MIN = 0;
const CUSTOM_ROUTING_PRIORITY_MAX = 100;
const CUSTOM_ROUTING_WEIGHT_MIN = 1;
const CUSTOM_ROUTING_WEIGHT_MAX = 100;

function normalizeAccessScope(value: string): CodexLocalAccessScope {
  return value === 'lan' ? 'lan' : 'localhost';
}

function normalizeStatsRangeKey(value: string | null | undefined): StatsRangeKey {
  if (value === 'weekly' || value === 'monthly') {
    return value;
  }
  return 'daily';
}

function normalizeCpaAccountEmail(value?: string | null): string {
  return value?.trim().toLowerCase() || '';
}

function readYamlScalar(config: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm');
  const match = config.match(pattern);
  if (!match) return fallback;
  return match[1].trim().replace(/^['"]|['"]$/g, '') || fallback;
}

function replaceYamlScalar(config: string, key: string, value: string): string {
  const pattern = new RegExp(`^(\\s*${key}\\s*:\\s*).*$`, 'm');
  if (pattern.test(config)) {
    return config.replace(pattern, `$1${value}`);
  }
  const suffix = config.endsWith('\n') ? '' : '\n';
  return `${config}${suffix}${key}: ${value}\n`;
}

function formatCpaDateTime(value?: string | null): string {
  if (!value) return '-';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeCustomRoutingPriority(value: number): number {
  return clampInteger(value, CUSTOM_ROUTING_PRIORITY_MIN, CUSTOM_ROUTING_PRIORITY_MAX);
}

function normalizeCustomRoutingWeight(value: number): number {
  return clampInteger(value, CUSTOM_ROUTING_WEIGHT_MIN, CUSTOM_ROUTING_WEIGHT_MAX);
}

function readStoredStatsRange(): StatsRangeKey {
  try {
    return normalizeStatsRangeKey(localStorage.getItem(CODEX_LOCAL_ACCESS_STATS_RANGE_STORAGE_KEY));
  } catch {
    return 'daily';
  }
}

function createCustomCredentialDraft(name: string): CodexLocalAccessCustomCredential {
  const now = Date.now();
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${now}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id: `custom_${suffix}`,
    name,
    baseUrl: '',
    apiKey: '',
    createdAt: now,
    updatedAt: now,
  };
}

function readCustomCredentialsFromCollection(
  collection: CodexLocalAccessCollectionState | null,
  defaultName: string,
): CodexLocalAccessCustomCredential[] {
  if (!collection) return [];
  const savedCredentials = collection.customCredentials ?? [];
  if (savedCredentials.length > 0) {
    return savedCredentials.map((credential, index) => ({
      ...credential,
      name: credential.name?.trim() || `${defaultName} ${index + 1}`,
      baseUrl: credential.baseUrl ?? '',
      apiKey: credential.apiKey ?? '',
      createdAt: credential.createdAt || Date.now(),
      updatedAt: credential.updatedAt || Date.now(),
    }));
  }

  const legacyBaseUrl = collection.customBaseUrl?.trim() ?? '';
  const legacyApiKey = collection.customApiKey?.trim() ?? '';
  if (!legacyBaseUrl && !legacyApiKey) return [];

  return [
    {
      id: collection.activeCustomCredentialId?.trim() || 'custom_legacy',
      name: `${defaultName} 1`,
      baseUrl: legacyBaseUrl,
      apiKey: legacyApiKey,
      createdAt: collection.createdAt || Date.now(),
      updatedAt: collection.updatedAt || Date.now(),
    },
  ];
}

function persistStatsRange(value: StatsRangeKey): void {
  try {
    localStorage.setItem(CODEX_LOCAL_ACCESS_STATS_RANGE_STORAGE_KEY, value);
  } catch {
    // ignore storage write failures
  }
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value || 0);
}

function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function formatQuotaPoolLabel(
  baseLabel: string,
  pool: CodexQuotaPoolItem,
  hourlyLabel: string,
  weeklyLabel: string,
): string {
  return `${baseLabel} · ${hourlyLabel} ${formatCodexQuotaPoolPercent(pool.hourly)} · ${weeklyLabel} ${formatCodexQuotaPoolPercent(pool.weekly)}`;
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function CodexLocalAccessModal({
  isOpen,
  mode,
  state,
  addressKind,
  addressOptions,
  onAddressKindChange,
  accounts,
  accountGroups,
  initialSelectedIds,
  maskAccountText,
  onClose,
  onOpenFullPage,
  onSaveAccounts,
  onClearStats,
  onRefreshStats,
  onUpdatePort,
  onUpdateRoutingStrategy,
  onUpdateCustomRouting,
  onUpdateAccessScope,
  onUpdateCredentials,
  onUpdateUpstreamProxyConfig,
  onUpdateDebugLogs,
  onRotateApiKey,
  onKillPort,
  onToggleEnabled,
  onTest,
  planBadgeStylePreferences,
  saving,
  testing,
  starting,
  portCleanupBusy,
}: CodexLocalAccessModalProps) {
  const { t } = useTranslation();
  useEscClose(isOpen, onClose);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterTypes, setFilterTypes] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [restrictFreeAccounts, setRestrictFreeAccounts] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testDialogRunning, setTestDialogRunning] = useState(false);
  const [testDialogResult, setTestDialogResult] =
    useState<CodexLocalAccessTestResult | null>(null);
  const [testDialogError, setTestDialogError] = useState('');
  const [portInput, setPortInput] = useState('');
  const [credentialModeInput, setCredentialModeInput] =
    useState<CodexLocalAccessCredentialMode>('local');
  const [customCredentialsInput, setCustomCredentialsInput] = useState<
    CodexLocalAccessCustomCredential[]
  >([]);
  const [activeCustomCredentialIdInput, setActiveCustomCredentialIdInput] =
    useState('');
  const [upstreamProxyDraftUrl, setUpstreamProxyDraftUrl] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [customApiKeyVisible, setCustomApiKeyVisible] = useState(false);
  const [copiedField, setCopiedField] = useState<CopyableField | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [statsRange, setStatsRange] = useState<StatsRangeKey>(() => readStoredStatsRange());
  const [customRoutingOpen, setCustomRoutingOpen] = useState(false);
  const [customRoutingQuery, setCustomRoutingQuery] = useState('');
  const [customRoutingFilterTypes, setCustomRoutingFilterTypes] = useState<string[]>([]);
  const [customRoutingTagFilter, setCustomRoutingTagFilter] = useState<string[]>([]);
  const [customRoutingError, setCustomRoutingError] = useState('');
  const [customRoutingSelected, setCustomRoutingSelected] = useState<Set<string>>(new Set());
  const [customRoutingDraft, setCustomRoutingDraft] = useState<Record<string, CustomRoutingDraftRule>>({});
  const [customRoutingBulkPriority, setCustomRoutingBulkPriority] = useState('10');
  const [customRoutingBulkWeight, setCustomRoutingBulkWeight] = useState('1');
  const [cpaAccountFiles, setCpaAccountFiles] = useState<
    codexService.CodexCpaAccountFile[]
  >([]);
  const [cpaServiceState, setCpaServiceState] =
    useState<codexService.CodexCpaServiceState | null>(null);
  const [cpaServiceLoading, setCpaServiceLoading] = useState(false);
  const [cpaServiceBusy, setCpaServiceBusy] = useState(false);
  const [cpaServiceError, setCpaServiceError] = useState('');
  const [showCpaServiceManager, setShowCpaServiceManager] = useState(false);
  const [cpaConfigDraft, setCpaConfigDraft] = useState('');
  const [cpaManagementPasswordDraft, setCpaManagementPasswordDraft] = useState('ab2026ab');
  const [cpaRuntimeBusy, setCpaRuntimeBusy] = useState(false);
  const [cpaUpdateInfo, setCpaUpdateInfo] =
    useState<codexService.CodexCpaUpdateInfo | null>(null);
  const [externalModelIds, setExternalModelIds] = useState<string[]>([]);
  const [externalModelsLoading, setExternalModelsLoading] = useState(false);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const customRoutingSelectAllRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const collection = state?.collection ?? null;
  const apiPortUrl = state?.apiPortUrl ?? '';
  const baseUrl = state?.baseUrl ?? '';
  const displayBaseUrl =
    addressKind === 'lan' && state?.lanBaseUrl ? state.lanBaseUrl : baseUrl;
  const credentialMode = collection?.credentialMode ?? 'local';
  const isCpaCredentialMode = credentialMode === 'cpa';
  const isExternalCredentialMode = credentialMode !== 'local';
  const collectionCustomCredentials = useMemo(
    () =>
      readCustomCredentialsFromCollection(
        collection,
        t('codex.localAccess.customProfileDefaultName', '自定义配置'),
      ),
    [collection, t],
  );
  const activeCollectionCustomCredential = useMemo(() => {
    const activeId = collection?.activeCustomCredentialId?.trim();
    return (
      collectionCustomCredentials.find((credential) => credential.id === activeId) ??
      collectionCustomCredentials[0] ??
      null
    );
  }, [collection?.activeCustomCredentialId, collectionCustomCredentials]);
  const activeCustomCredentialInput = useMemo(
    () =>
      customCredentialsInput.find(
        (credential) => credential.id === activeCustomCredentialIdInput,
      ) ??
      customCredentialsInput[0] ??
      null,
    [activeCustomCredentialIdInput, customCredentialsInput],
  );
  const activeCustomCredentialOptionValue =
    activeCustomCredentialInput?.id ?? '';
  const isCustomCredentialDraftMode = credentialModeInput === 'custom';
  const isCpaCredentialDraftMode = credentialModeInput === 'cpa';
  const isExternalCredentialDraftMode = credentialModeInput !== 'local';
  const isCpaPanelMode = isCpaCredentialMode || isCpaCredentialDraftMode;
  const isExternalCredentialPanelMode =
    isExternalCredentialMode || isExternalCredentialDraftMode;
  const showBuiltInNetworkConfig = !isExternalCredentialDraftMode;
  const activeBaseUrl = isCpaCredentialDraftMode
    ? cpaServiceState?.baseUrl || CODEX_CPA_SERVICE_BASE_URL
    : isCustomCredentialDraftMode
    ? activeCustomCredentialInput?.baseUrl?.trim() ??
      activeCollectionCustomCredential?.baseUrl?.trim() ??
      collection?.customBaseUrl?.trim() ??
      ''
    : displayBaseUrl;
  const activeApiKey = isCpaCredentialDraftMode
    ? cpaServiceState?.apiKey || CODEX_CPA_SERVICE_API_KEY
    : isCustomCredentialDraftMode
    ? activeCustomCredentialInput?.apiKey?.trim() ??
      activeCollectionCustomCredential?.apiKey?.trim() ??
      collection?.customApiKey?.trim() ??
      ''
    : collection?.apiKey ?? '';
  const modelIds = state?.modelIds ?? [];
  const displayModelIds = isExternalCredentialPanelMode ? externalModelIds : modelIds;
  const stats = state?.stats;
  const statsRangeOptions = useMemo(
    () =>
      [
        { key: 'daily', label: t('codex.localAccess.statsRange.daily', '日') },
        { key: 'weekly', label: t('codex.localAccess.statsRange.weekly', '周') },
        { key: 'monthly', label: t('codex.localAccess.statsRange.monthly', '月') },
      ] satisfies Array<{ key: StatsRangeKey; label: string }>,
    [t],
  );
  const quotaPoolLabels = useMemo(
    () => ({
      hourly: t('codex.localAccess.quotaPool.hourlyShort', '5h'),
      weekly: t('codex.localAccess.quotaPool.weeklyShort', '周'),
      title: t('codex.localAccess.quotaPool.title', '额度池'),
    }),
    [t],
  );
  const selectedStatsWindow = useMemo<CodexLocalAccessStatsWindow | null>(() => {
    if (!stats) return null;
    return stats[statsRange];
  }, [stats, statsRange]);
  const selectedTotals = selectedStatsWindow?.totals;
  const routingStrategy = collection?.routingStrategy ?? 'auto';
  const accessScope = collection?.accessScope ?? 'localhost';
  const upstreamProxyUrl = collection?.upstreamProxyUrl ?? '';
  const accessScopeAddress =
    accessScope === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const accessScopeBadge =
    accessScope === 'lan'
      ? t('codex.localAccess.accessScopeLanShort', '本机+局域网')
      : t('codex.localAccess.accessScopeLocalhostShort', '仅本机');
  const modelIdOptions = useMemo(
    () => displayModelIds.map((modelId) => ({ value: modelId, label: modelId })),
    [displayModelIds],
  );
  const avgLatencyMs =
    selectedTotals && selectedTotals.requestCount > 0
      ? selectedTotals.totalLatencyMs / selectedTotals.requestCount
      : 0;
  const successRate =
    selectedTotals && selectedTotals.requestCount > 0
      ? Math.round((selectedTotals.successCount / selectedTotals.requestCount) * 100)
      : 0;
  const formatRequestResultDetail = (usage?: CodexLocalAccessUsageStats | null) =>
    t('codex.localAccess.stats.requestsDetail', {
      success: formatCompactNumber(usage?.successCount ?? 0),
      failed: formatCompactNumber(
        Math.max(
            (usage?.failureCount ?? 0) -
            (usage?.clientCanceledCount ?? 0) -
            (usage?.upstreamResponseFailedCount ?? 0) -
            (usage?.streamIncompleteCount ?? 0),
          0,
        ),
      ),
      canceled: formatCompactNumber(usage?.clientCanceledCount ?? 0),
      upstreamFailed: formatCompactNumber(usage?.upstreamResponseFailedCount ?? 0),
      incomplete: formatCompactNumber(usage?.streamIncompleteCount ?? 0),
      defaultValue:
        '成功 {{success}} / 失败 {{failed}} / 取消 {{canceled}} / 上游失败 {{upstreamFailed}} / 流未完成 {{incomplete}}',
    });
  const testDialogBusy = testDialogRunning || testing;
  const actionBusy = saving || testing || starting || portCleanupBusy;
  const cpaServiceRunning = Boolean(cpaServiceState?.running);
  const cpaServiceStateTone = cpaServiceLoading
    ? 'checking'
    : cpaServiceRunning
    ? 'running'
    : 'stopped';
  const cpaServiceStateText = cpaServiceLoading
    ? t('codex.localAccess.cpaServiceChecking', '检测中')
    : cpaServiceRunning
    ? t('codex.localAccess.cpaServiceRunning', '已启动')
    : t('codex.localAccess.cpaServiceStopped', '未启动');
  const cpaConfigPortInput = readYamlScalar(
    cpaConfigDraft,
    'port',
    String(cpaServiceState?.port ?? 8317),
  );
  const panelServiceStatusTone = !collection
    ? 'disabled'
    : isCpaPanelMode
    ? cpaServiceStateTone
    : state?.running
    ? 'running'
    : collection.enabled
    ? 'stopped'
    : 'disabled';
  const panelServiceStatusText = !collection
    ? t('codex.localAccess.statusDisabled', '已停用')
    : isCpaPanelMode
    ? cpaServiceStateText
    : collection.enabled
    ? state?.running
      ? t('codex.localAccess.statusRunning', '运行中')
      : t('codex.localAccess.statusStopped', '未运行')
    : t('codex.localAccess.statusDisabled', '已停用');
  const summaryStats = useMemo(
    () => [
      {
        key: 'requests',
        label: t('codex.localAccess.stats.requests', '总请求数'),
        value: formatCompactNumber(selectedTotals?.requestCount ?? 0),
        detail: formatRequestResultDetail(selectedTotals),
      },
      {
        key: 'tokens',
        label: t('codex.localAccess.stats.tokens', '总 Token 数'),
        value: formatCompactNumber(selectedTotals?.totalTokens ?? 0),
        detail: t('codex.localAccess.stats.tokensDetail', {
          input: formatCompactNumber(selectedTotals?.inputTokens ?? 0),
          output: formatCompactNumber(selectedTotals?.outputTokens ?? 0),
          defaultValue: '输入 {{input}} / 输出 {{output}}',
        }),
      },
      {
        key: 'specialTokens',
        label: t('codex.localAccess.stats.specialTokens', '缓存 / 思考'),
        value: formatCompactNumber(
          (selectedTotals?.cachedTokens ?? 0) + (selectedTotals?.reasoningTokens ?? 0),
        ),
        detail: t('codex.localAccess.stats.specialTokensDetail', {
          cached: formatCompactNumber(selectedTotals?.cachedTokens ?? 0),
          reasoning: formatCompactNumber(selectedTotals?.reasoningTokens ?? 0),
          defaultValue: '缓存 {{cached}} / 思考 {{reasoning}}',
        }),
      },
      {
        key: 'latency',
        label: t('codex.localAccess.stats.avgLatency', '平均延迟'),
        value: formatLatencyMs(avgLatencyMs),
        detail: t('codex.localAccess.stats.successRate', {
          rate: successRate,
          defaultValue: '成功率 {{rate}}%',
        }),
      },
    ],
    [avgLatencyMs, selectedTotals, successRate, t],
  );

  const localAccessAccounts = useMemo(
    () => accounts,
    [accounts],
  );
  const quotaPoolSummary = useMemo(
    () => summarizeCodexQuotaPool(localAccessAccounts),
    [localAccessAccounts],
  );
  const currentQuotaPoolSummary = useMemo(() => {
    const accountIds = new Set(collection?.accountIds ?? []);
    return summarizeCodexQuotaPool(localAccessAccounts.filter((account) => accountIds.has(account.id)));
  }, [collection?.accountIds, localAccessAccounts]);
  const localAccessAccountIdSet = useMemo(
    () => new Set(localAccessAccounts.map((account) => account.id)),
    [localAccessAccounts],
  );
  const normalizedInitialSelectedIds = useMemo(
    () => initialSelectedIds.filter((accountId) => localAccessAccountIdSet.has(accountId)),
    [initialSelectedIds, localAccessAccountIdSet],
  );

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelected(new Set(normalizedInitialSelectedIds));
    setFilterTypes([]);
    setTagFilter([]);
    setGroupFilter([]);
    setRestrictFreeAccounts(collection?.restrictFreeAccounts ?? true);
    setError('');
    setNotice('');
    setTestDialogOpen(false);
    setTestDialogRunning(false);
    setTestDialogResult(null);
    setTestDialogError('');
    setKeyVisible(false);
    setCustomApiKeyVisible(false);
    setCopiedField(null);
    setPortInput(collection?.port ? String(collection.port) : '');
    setCredentialModeInput(collection?.credentialMode ?? 'local');
    setCustomCredentialsInput(collectionCustomCredentials);
    setActiveCustomCredentialIdInput(
      collection?.activeCustomCredentialId?.trim() ||
        collectionCustomCredentials[0]?.id ||
        '',
    );
    setUpstreamProxyDraftUrl(collection?.upstreamProxyUrl ?? '');
    setCustomRoutingOpen(false);
    setCustomRoutingQuery('');
    setCustomRoutingFilterTypes([]);
    setCustomRoutingTagFilter([]);
    setCustomRoutingError('');
    setCustomRoutingSelected(new Set());
    setCustomRoutingDraft(() => {
      const ruleMap = new Map(
        (collection?.customRoutingRules ?? []).map((rule) => [
          rule.accountId,
          {
            priority: normalizeCustomRoutingPriority(rule.priority),
            weight: normalizeCustomRoutingWeight(rule.weight),
          },
        ]),
      );
      const next: Record<string, CustomRoutingDraftRule> = {};
      (collection?.accountIds ?? []).forEach((accountId) => {
        next[accountId] = ruleMap.get(accountId) ?? {
          priority: CUSTOM_ROUTING_PRIORITY_MIN,
          weight: CUSTOM_ROUTING_WEIGHT_MIN,
        };
      });
      return next;
    });
    setCustomRoutingBulkPriority('10');
    setCustomRoutingBulkWeight('1');
    if (mode === 'members') {
      window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [
    collection?.credentialMode,
    collection?.customApiKey,
    collection?.customBaseUrl,
    collection?.activeCustomCredentialId,
    collection?.accountIds,
    collection?.apiKeys,
    collection?.customRoutingRules,
    collection?.port,
    collection?.restrictFreeAccounts,
    collectionCustomCredentials,
    collection?.upstreamProxyUrl,
    isOpen,
    mode,
    normalizedInitialSelectedIds,
  ]);

  const refreshCpaAccountFiles = async () => {
    try {
      const files = await codexService.listCodexCpaAccounts();
      setCpaAccountFiles(files);
    } catch (err) {
      console.warn('[CodexCPA] load account files failed:', err);
      setCpaAccountFiles([]);
    }
  };

  const refreshCpaServiceState = async () => {
    setCpaServiceLoading(true);
    try {
      const nextState = await codexService.getCodexCpaServiceState();
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      setCpaServiceError('');
      return nextState;
    } catch (err) {
      const message = String(err).replace(/^Error:\s*/, '');
      setCpaServiceError(message);
      return null;
    } finally {
      setCpaServiceLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'members' || isCpaCredentialMode || isCpaCredentialDraftMode) {
      void refreshCpaAccountFiles();
    }
  }, [isOpen, isCpaCredentialDraftMode, isCpaCredentialMode, mode]);

  useEffect(() => {
    if (!isOpen) return;
    if (!isCpaCredentialMode && !isCpaCredentialDraftMode) {
      setCpaServiceState(null);
      setCpaServiceError('');
      setShowCpaServiceManager(false);
      setCpaConfigDraft('');
      setCpaUpdateInfo(null);
      setExternalModelIds([]);
      return;
    }
    void refreshCpaServiceState();
  }, [isOpen, isCpaCredentialDraftMode, isCpaCredentialMode]);

  const dispatchCpaServiceStateUpdated = () => {
    window.dispatchEvent(new Event('codex-cpa-service-state-updated'));
  };

  const syncCpaCredentialsFromServiceState = useCallback(
    async (nextState: CodexCpaServiceState) => {
      if (!isCpaCredentialMode) return;
      await onUpdateCredentials({
        credentialMode: 'cpa',
        activeCustomCredentialId: 'cpa-service',
        customCredentials: null,
        customBaseUrl: nextState.baseUrl,
        customApiKey: nextState.apiKey,
        ensureCpaService: false,
      });
    },
    [isCpaCredentialMode, onUpdateCredentials],
  );

  const handleOpenCpaServiceManager = async () => {
    await refreshCpaServiceState();
    setShowCpaServiceManager(true);
  };

  const handleStartCpaService = async () => {
    if (cpaServiceState && !cpaServiceState.runtimeInstalled) {
      setCpaServiceError(
        t(
          'codex.localAccess.cpaRuntimeMissing',
          '未安装 CPA 运行时，请先下载或导入安装包。',
        ),
      );
      setShowCpaServiceManager(true);
      return;
    }
    setCpaServiceBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.startCodexCpaService();
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
      await syncCpaCredentialsFromServiceState(nextState);
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaServiceBusy(false);
    }
  };

  const confirmStopCpaService = async () =>
    confirmDialog(
      t(
        'codex.localAccess.cpaStopConfirm',
        '停止 CPA 服务后，当前通过 http://127.0.0.1:8317/v1 的请求会中断，确认停止吗？',
      ),
      {
        title: t('codex.localAccess.cpaStopConfirmTitle', '停止 CPA 服务'),
        kind: 'warning',
        okLabel: t('codex.localAccess.cpaStop', '停止'),
        cancelLabel: t('common.cancel', '取消'),
      },
    );

  const handleStopCpaService = async () => {
    const confirmed = await confirmStopCpaService();
    if (!confirmed) return;

    setCpaServiceBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.stopCodexCpaService();
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
      await syncCpaCredentialsFromServiceState(nextState);
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaServiceBusy(false);
    }
  };

  const handleSaveCpaConfig = async () => {
    setCpaRuntimeBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.saveCodexCpaServiceConfig(
        cpaConfigDraft,
        cpaManagementPasswordDraft,
      );
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaRuntimeBusy(false);
    }
  };

  const handleRestoreCpaConfig = async () => {
    const confirmed = await confirmDialog(
      t('codex.localAccess.cpaRestoreDefaultConfirm', '恢复默认 CPA 配置会覆盖当前配置内容，确认继续吗？'),
      {
        title: t('codex.localAccess.cpaRestoreDefault', '恢复默认'),
        kind: 'warning',
        okLabel: t('common.confirm', '确认'),
        cancelLabel: t('common.cancel', '取消'),
      },
    );
    if (!confirmed) return;
    setCpaRuntimeBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.restoreCodexCpaServiceDefaultConfig();
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaRuntimeBusy(false);
    }
  };

  const handleImportCpaRuntime = async () => {
    const selectedPath = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'CLIProxyAPI', extensions: ['gz', 'tar.gz'] }],
    });
    if (typeof selectedPath !== 'string') return;
    setCpaRuntimeBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.importCodexCpaRuntime(selectedPath);
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaRuntimeBusy(false);
    }
  };

  const handleCheckCpaUpdate = async () => {
    setCpaRuntimeBusy(true);
    setCpaServiceError('');
    try {
      const update = await codexService.checkCodexCpaRuntimeUpdate();
      setCpaUpdateInfo(update);
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaRuntimeBusy(false);
    }
  };

  const handleDownloadLatestCpaRuntime = async () => {
    setCpaRuntimeBusy(true);
    setCpaServiceError('');
    try {
      const nextState = await codexService.downloadLatestCodexCpaRuntime();
      setCpaServiceState(nextState);
      setCpaConfigDraft(nextState.configContent ?? '');
      setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
      dispatchCpaServiceStateUpdated();
    } catch (err) {
      setCpaServiceError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setCpaRuntimeBusy(false);
    }
  };

  const handleFetchExternalModels = async () => {
    setExternalModelsLoading(true);
    setError('');
    try {
      const models = await codexLocalAccessService.fetchCodexLocalAccessExternalModels(
        activeBaseUrl,
        activeApiKey,
      );
      setExternalModelIds(models);
      setSelectedModelId(models[0] ?? '');
      setNotice(t('codex.localAccess.externalModelsLoaded', '模型列表已更新'));
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setExternalModelsLoading(false);
    }
  };

  useEffect(() => {
    if (displayModelIds.length === 0) {
      setSelectedModelId('');
      return;
    }
    setSelectedModelId((current) =>
      displayModelIds.includes(current) ? current : displayModelIds[0],
    );
  }, [displayModelIds]);

  useEffect(() => {
    persistStatsRange(statsRange);
  }, [statsRange]);

  useEffect(() => {
    setExternalModelIds([]);
  }, [activeBaseUrl, activeApiKey, isExternalCredentialPanelMode]);

  const normalizeTag = (value: string) => value.trim().toLowerCase();

  const availableTags = useMemo(() => {
    const next = new Set<string>();
    localAccessAccounts.forEach((account) => {
      (account.tags || []).forEach((tag) => {
        const trimmed = tag.trim();
        if (trimmed) next.add(trimmed);
      });
    });
    return Array.from(next).sort((left, right) => left.localeCompare(right));
  }, [localAccessAccounts]);

  const groupIdsByAccountId = useMemo(() => {
    const next = new Map<string, Set<string>>();
    accountGroups.forEach((group) => {
      group.accountIds.forEach((accountId) => {
        const current = next.get(accountId) ?? new Set<string>();
        current.add(group.id);
        next.set(accountId, current);
      });
    });
    return next;
  }, [accountGroups]);

  const groupNameByAccountId = useMemo(() => {
    const next = new Map<string, string[]>();
    accountGroups.forEach((group) => {
      group.accountIds.forEach((accountId) => {
        const current = next.get(accountId) ?? [];
        current.push(group.name);
        next.set(accountId, current);
      });
    });
    return next;
  }, [accountGroups]);

  const groupFilterOptions = useMemo<MultiSelectFilterOption[]>(
    () =>
      accountGroups
        .map((group) => ({
          value: group.id,
          label: `${group.name} (${group.accountIds.length})`,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [accountGroups],
  );

  const cpaAccountEmailSet = useMemo(
    () =>
      new Set(
        cpaAccountFiles
          .filter((file) => file.valid)
          .map((file) => normalizeCpaAccountEmail(file.email))
          .filter(Boolean),
      ),
    [cpaAccountFiles],
  );
  const cpaCollectionAccountIdSet = useMemo(
    () =>
      isCpaPanelMode
        ? new Set(collection?.accountIds ?? [])
        : new Set<string>(),
    [collection?.accountIds, isCpaPanelMode],
  );
  const isCpaAccount = useCallback(
    (account: CodexAccount) =>
      cpaAccountEmailSet.has(normalizeCpaAccountEmail(account.email)) ||
      cpaCollectionAccountIdSet.has(account.id),
    [cpaAccountEmailSet, cpaCollectionAccountIdSet],
  );

  const tierCounts = useMemo(() => {
    const counts = { all: localAccessAccounts.length, VALID: 0, FREE: 0, API_KEY: 0, PLUS: 0, PRO: 0, TEAM: 0, ENTERPRISE: 0, ERROR: 0, CPA: 0 };
    localAccessAccounts.forEach((account) => {
      if (!isBlockingCodexQuotaError(account.quota_error)) {
        counts.VALID += 1;
      }
      const tier = getCodexPlanFilterKey(account);
      if (tier in counts) {
        counts[tier as keyof typeof counts] += 1;
      }
      if (isBlockingCodexQuotaError(account.quota_error)) {
        counts.ERROR += 1;
      }
      if (isCpaAccount(account)) {
        counts.CPA += 1;
      }
    });
    return counts;
  }, [isCpaAccount, localAccessAccounts]);

  const allTierFilterLabel = useMemo(
    () =>
      formatQuotaPoolLabel(
        t('common.shared.filter.all', { count: tierCounts.all }),
        quotaPoolSummary.all,
        quotaPoolLabels.hourly,
        quotaPoolLabels.weekly,
      ),
    [quotaPoolLabels.hourly, quotaPoolLabels.weekly, quotaPoolSummary.all, t, tierCounts.all],
  );

  const tierFilterOptions = useMemo<MultiSelectFilterOption[]>(
    () => [
      {
        value: 'FREE',
        label: formatQuotaPoolLabel(
          `FREE (${tierCounts.FREE})`,
          quotaPoolSummary.byPlan.FREE,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'API_KEY',
        label: formatQuotaPoolLabel(
          `API Key (${tierCounts.API_KEY})`,
          quotaPoolSummary.byPlan.API_KEY,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'PLUS',
        label: formatQuotaPoolLabel(
          `PLUS (${tierCounts.PLUS})`,
          quotaPoolSummary.byPlan.PLUS,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'PRO',
        label: formatQuotaPoolLabel(
          `PRO (${tierCounts.PRO})`,
          quotaPoolSummary.byPlan.PRO,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'TEAM',
        label: formatQuotaPoolLabel(
          `TEAM (${tierCounts.TEAM})`,
          quotaPoolSummary.byPlan.TEAM,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'ENTERPRISE',
        label: formatQuotaPoolLabel(
          `ENTERPRISE (${tierCounts.ENTERPRISE})`,
          quotaPoolSummary.byPlan.ENTERPRISE,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      { value: 'ERROR', label: `ERROR (${tierCounts.ERROR})` },
      {
        value: 'CPA',
        label: t('codex.cpa.accountFilter', {
          count: tierCounts.CPA,
          defaultValue: 'CPA 账号 ({{count}})',
        }),
      },
      buildValidAccountsFilterOption(t, tierCounts.VALID),
    ],
    [quotaPoolLabels.hourly, quotaPoolLabels.weekly, quotaPoolSummary.byPlan, t, tierCounts],
  );

  const visibleAccounts = useMemo(() => {
    const queryText = query.trim().toLowerCase();
    const sorted = [...localAccessAccounts].sort((a, b) => {
      const aName = buildCodexAccountPresentation(a, t).displayName.toLowerCase();
      const bName = buildCodexAccountPresentation(b, t).displayName.toLowerCase();
      return aName.localeCompare(bName);
    });
    const selectedTags = new Set(tagFilter.map(normalizeTag));
    const selectedGroups = new Set(groupFilter);
    const { requireValidAccounts, selectedTypes } = splitValidityFilterValues(filterTypes);

    return sorted.filter((account) => {
      const presentation = buildCodexAccountPresentation(account, t);
      const displayName = presentation.displayName.toLowerCase();
      const groupNames = (groupNameByAccountId.get(account.id) ?? []).join(' ').toLowerCase();
      const matchesQuery =
        !queryText || displayName.includes(queryText) || groupNames.includes(queryText);
      if (!matchesQuery) return false;

      if (selectedTags.size > 0) {
        const accountTags = (account.tags || []).map(normalizeTag);
        if (!accountTags.some((tag) => selectedTags.has(tag))) {
          return false;
        }
      }

      if (selectedGroups.size > 0) {
        const accountGroupIds = groupIdsByAccountId.get(account.id);
        if (!accountGroupIds || !Array.from(accountGroupIds).some((id) => selectedGroups.has(id))) {
          return false;
        }
      }

      if (
        requireValidAccounts &&
        isBlockingCodexQuotaError(account.quota_error)
      ) {
        return false;
      }

      if (selectedTypes.size > 0) {
        const planKey = getCodexPlanFilterKey(account);
        const matchesType = Array.from(selectedTypes).some((type) => {
          if (type === 'CPA') {
            return isCpaAccount(account);
          }
          if (type === 'ERROR') {
            return isBlockingCodexQuotaError(account.quota_error);
          }
          return type === planKey;
        });
        if (!matchesType) {
          return false;
        }
      }

      return true;
    });
  }, [filterTypes, groupFilter, groupIdsByAccountId, groupNameByAccountId, isCpaAccount, localAccessAccounts, query, t, tagFilter]);

  const visibleSelectableAccounts = useMemo(
    () =>
      visibleAccounts.filter((account) => {
        if (isCodexLocalAccessEligibleAccount(account, restrictFreeAccounts)) {
          return true;
        }
        return selected.has(account.id);
      }),
    [restrictFreeAccounts, selected, visibleAccounts],
  );

  const selectedVisibleCount = useMemo(
    () =>
      visibleSelectableAccounts.reduce(
        (count, account) => count + (selected.has(account.id) ? 1 : 0),
        0,
      ),
    [selected, visibleSelectableAccounts],
  );

  const allVisibleSelected =
    visibleSelectableAccounts.length > 0 &&
    selectedVisibleCount === visibleSelectableAccounts.length;

  useEffect(() => {
    if (!selectAllCheckboxRef.current) return;
    selectAllCheckboxRef.current.indeterminate =
      selectedVisibleCount > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedVisibleCount]);

  const selectionDirty = useMemo(
    () =>
      !areSetsEqual(selected, new Set(normalizedInitialSelectedIds)) ||
      restrictFreeAccounts !== (collection?.restrictFreeAccounts ?? true),
    [collection?.restrictFreeAccounts, normalizedInitialSelectedIds, restrictFreeAccounts, selected],
  );

  const allStatsByAccountId = useMemo(() => {
    const next = new Map<string, NonNullable<CodexLocalAccessState['stats']>['accounts'][number]>();
    stats?.accounts.forEach((item) => next.set(item.accountId, item));
    return next;
  }, [stats?.accounts]);

  const windowStatsByAccountId = useMemo(() => {
    const next = new Map<string, NonNullable<CodexLocalAccessState['stats']>['accounts'][number]>();
    selectedStatsWindow?.accounts.forEach((item) => next.set(item.accountId, item));
    return next;
  }, [selectedStatsWindow?.accounts]);

  const currentMemberStats = useMemo(() => {
    const currentIds = collection?.accountIds ?? [];
    return currentIds
      .map((accountId) => {
        const account = localAccessAccounts.find((item) => item.id === accountId);
        if (!account) return null;
        const presentation = buildCodexAccountPresentation(account, t);
        const accountStats = windowStatsByAccountId.get(account.id);
        return {
          account,
          presentation,
          stats: accountStats?.usage ?? null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => {
        const rightCount = right.stats?.requestCount ?? 0;
        const leftCount = left.stats?.requestCount ?? 0;
        return rightCount - leftCount;
      });
  }, [collection?.accountIds, localAccessAccounts, t, windowStatsByAccountId]);

  const routingStrategyOptions = useMemo(
    () => [
      {
        value: 'auto',
        label: t('codex.localAccess.routingStrategy.auto', '自动（推荐）'),
      },
      {
        value: 'quota_high_first',
        label: t('codex.localAccess.routingStrategy.quotaHighFirst', '优先高配额'),
      },
      {
        value: 'quota_low_first',
        label: t('codex.localAccess.routingStrategy.quotaLowFirst', '优先低配额'),
      },
      {
        value: 'plan_high_first',
        label: t('codex.localAccess.routingStrategy.planHighFirst', '优先高订阅'),
      },
      {
        value: 'plan_low_first',
        label: t('codex.localAccess.routingStrategy.planLowFirst', '优先低订阅'),
      },
      {
        value: 'expiry_soon_first',
        label: t('codex.localAccess.routingStrategy.expirySoonFirst', '优先近到期'),
      },
      {
        value: 'custom',
        label: t('codex.localAccess.routingStrategy.custom', '自定义'),
      },
    ] satisfies Array<{ value: CodexLocalAccessRoutingStrategy; label: string }>,
    [t],
  );
  const accessScopeOptions = useMemo(
    () => [
      {
        value: 'localhost',
        label: t('codex.localAccess.accessScopeLocalhost', '仅本机'),
      },
      {
        value: 'lan',
        label: t('codex.localAccess.accessScopeLan', '局域网'),
      },
    ],
    [t],
  );
  const credentialModeOptions = useMemo(
    () => [
      {
        value: 'local',
        label: t('codex.localAccess.credentialModeLocal', '内置服务'),
      },
      {
        value: 'custom',
        label: t('codex.localAccess.credentialModeCustom', '自定义配置'),
      },
      {
        value: 'cpa',
        label: t('codex.localAccess.credentialModeCpa', 'CPA 服务'),
      },
    ],
    [t],
  );
  const customCredentialOptions = useMemo(
    () =>
      customCredentialsInput.map((credential, index) => ({
        value: credential.id,
        label:
          credential.name.trim() ||
          t('codex.localAccess.customProfileFallbackName', {
            index: index + 1,
            defaultValue: '自定义配置 {{index}}',
          }),
      })),
    [customCredentialsInput, t],
  );
  const handleCredentialModeInputChange = (value: string) => {
    const nextMode = value as CodexLocalAccessCredentialMode;
    setCredentialModeInput(nextMode);
    if (nextMode === 'custom' && customCredentialsInput.length === 0) {
      const nextCredential = createCustomCredentialDraft(
        t('codex.localAccess.customProfileFallbackName', {
          index: 1,
          defaultValue: '自定义配置 {{index}}',
        }),
      );
      setCustomCredentialsInput([nextCredential]);
      setActiveCustomCredentialIdInput(nextCredential.id);
    }
  };

  const handleAddCustomCredential = () => {
    const nextCredential = createCustomCredentialDraft(
      t('codex.localAccess.customProfileFallbackName', {
        index: customCredentialsInput.length + 1,
        defaultValue: '自定义配置 {{index}}',
      }),
    );
    setCustomCredentialsInput((prev) => [...prev, nextCredential]);
    setActiveCustomCredentialIdInput(nextCredential.id);
  };

  const handleRemoveActiveCustomCredential = () => {
    if (!activeCustomCredentialInput) return;
    setCustomCredentialsInput((prev) => {
      const activeIndex = prev.findIndex(
        (credential) => credential.id === activeCustomCredentialInput.id,
      );
      const next = prev.filter(
        (credential) => credential.id !== activeCustomCredentialInput.id,
      );
      const fallback =
        next[Math.max(0, Math.min(activeIndex, next.length - 1))] ?? null;
      setActiveCustomCredentialIdInput(fallback?.id ?? '');
      return next;
    });
  };

  const updateActiveCustomCredentialInput = (
    patch: Partial<Pick<CodexLocalAccessCustomCredential, 'name' | 'baseUrl' | 'apiKey'>>,
  ) => {
    if (!activeCustomCredentialInput) return;
    setCustomCredentialsInput((prev) =>
      prev.map((credential) =>
        credential.id === activeCustomCredentialInput.id
          ? { ...credential, ...patch, updatedAt: Date.now() }
          : credential,
      ),
    );
  };

  const renderQuotaPreview = (
    presentation: ReturnType<typeof buildCodexAccountPresentation>,
    limit = 2,
  ) => {
    const quotaLines = buildQuotaPreviewLines(presentation.quotaItems, limit);
    if (quotaLines.length === 0) {
      return null;
    }

    return (
      <div className="codex-local-access-quota-line">
        {quotaLines.map((line) => (
          <span
            key={line.key}
            className={`codex-local-access-quota-chip ${line.quotaClass}`}
            title={line.title}
          >
            <span className="codex-local-access-quota-dot" />
            <span>{line.text}</span>
          </span>
        ))}
      </div>
    );
  };

  const localAccessAccountById = useMemo(
    () => new Map(localAccessAccounts.map((account) => [account.id, account])),
    [localAccessAccounts],
  );

  const customRoutingRuleByAccountId = useMemo(() => {
    const next = new Map<string, CustomRoutingDraftRule>();
    collection?.customRoutingRules?.forEach((rule) => {
      next.set(rule.accountId, {
        priority: normalizeCustomRoutingPriority(rule.priority),
        weight: normalizeCustomRoutingWeight(rule.weight),
      });
    });
    return next;
  }, [collection?.customRoutingRules]);

  const customRoutingAccounts = useMemo(() => {
    const currentIds = collection?.accountIds ?? [];
    return currentIds
      .map((accountId) => localAccessAccountById.get(accountId))
      .filter((account): account is CodexAccount => Boolean(account));
  }, [collection?.accountIds, localAccessAccountById]);

  const customRoutingAvailableTags = useMemo(() => {
    const next = new Set<string>();
    customRoutingAccounts.forEach((account) => {
      (account.tags || []).forEach((tag) => {
        const trimmed = tag.trim();
        if (trimmed) next.add(trimmed);
      });
    });
    return Array.from(next).sort((left, right) => left.localeCompare(right));
  }, [customRoutingAccounts]);

  const customRoutingQuotaPoolSummary = useMemo(
    () => summarizeCodexQuotaPool(customRoutingAccounts),
    [customRoutingAccounts],
  );

  const customRoutingTierCounts = useMemo(() => {
    const counts = { all: customRoutingAccounts.length, VALID: 0, FREE: 0, PLUS: 0, PRO: 0, TEAM: 0, ENTERPRISE: 0, ERROR: 0 };
    customRoutingAccounts.forEach((account) => {
      if (!isBlockingCodexQuotaError(account.quota_error)) {
        counts.VALID += 1;
      }
      const tier = getCodexPlanFilterKey(account);
      if (tier in counts) {
        counts[tier as keyof typeof counts] += 1;
      }
      if (isBlockingCodexQuotaError(account.quota_error)) {
        counts.ERROR += 1;
      }
    });
    return counts;
  }, [customRoutingAccounts]);

  const customRoutingAllTierFilterLabel = useMemo(
    () =>
      formatQuotaPoolLabel(
        t('common.shared.filter.all', { count: customRoutingTierCounts.all }),
        customRoutingQuotaPoolSummary.all,
        quotaPoolLabels.hourly,
        quotaPoolLabels.weekly,
      ),
    [
      customRoutingQuotaPoolSummary.all,
      customRoutingTierCounts.all,
      quotaPoolLabels.hourly,
      quotaPoolLabels.weekly,
      t,
    ],
  );

  const customRoutingTierFilterOptions = useMemo<MultiSelectFilterOption[]>(
    () => [
      {
        value: 'FREE',
        label: formatQuotaPoolLabel(
          `FREE (${customRoutingTierCounts.FREE})`,
          customRoutingQuotaPoolSummary.byPlan.FREE,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'PLUS',
        label: formatQuotaPoolLabel(
          `PLUS (${customRoutingTierCounts.PLUS})`,
          customRoutingQuotaPoolSummary.byPlan.PLUS,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'PRO',
        label: formatQuotaPoolLabel(
          `PRO (${customRoutingTierCounts.PRO})`,
          customRoutingQuotaPoolSummary.byPlan.PRO,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'TEAM',
        label: formatQuotaPoolLabel(
          `TEAM (${customRoutingTierCounts.TEAM})`,
          customRoutingQuotaPoolSummary.byPlan.TEAM,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      {
        value: 'ENTERPRISE',
        label: formatQuotaPoolLabel(
          `ENTERPRISE (${customRoutingTierCounts.ENTERPRISE})`,
          customRoutingQuotaPoolSummary.byPlan.ENTERPRISE,
          quotaPoolLabels.hourly,
          quotaPoolLabels.weekly,
        ),
      },
      { value: 'ERROR', label: `ERROR (${customRoutingTierCounts.ERROR})` },
      buildValidAccountsFilterOption(t, customRoutingTierCounts.VALID),
    ],
    [
      customRoutingQuotaPoolSummary.byPlan,
      customRoutingTierCounts,
      quotaPoolLabels.hourly,
      quotaPoolLabels.weekly,
      t,
    ],
  );

  const visibleCustomRoutingAccounts = useMemo(() => {
    const normalizedQuery = customRoutingQuery.trim().toLowerCase();
    const selectedTags = new Set(customRoutingTagFilter.map(normalizeTag));
    const { requireValidAccounts, selectedTypes } =
      splitValidityFilterValues(customRoutingFilterTypes);

    return customRoutingAccounts.filter((account) => {
      const presentation = buildCodexAccountPresentation(account, t);
      const matchesQuery =
        !normalizedQuery ||
        presentation.displayName.toLowerCase().includes(normalizedQuery) ||
        account.id.toLowerCase().includes(normalizedQuery) ||
        presentation.planLabel.toLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;

      if (selectedTags.size > 0) {
        const accountTags = (account.tags || []).map(normalizeTag);
        if (!accountTags.some((tag) => selectedTags.has(tag))) {
          return false;
        }
      }

      if (
        requireValidAccounts &&
        isBlockingCodexQuotaError(account.quota_error)
      ) {
        return false;
      }

      if (selectedTypes.size > 0) {
        const planKey = getCodexPlanFilterKey(account);
        const matchesType = Array.from(selectedTypes).some((type) => {
          if (type === 'ERROR') {
            return isBlockingCodexQuotaError(account.quota_error);
          }
          return type === planKey;
        });
        if (!matchesType) {
          return false;
        }
      }

      return true;
    });
  }, [
    customRoutingAccounts,
    customRoutingFilterTypes,
    customRoutingQuery,
    customRoutingTagFilter,
    t,
  ]);

  const selectedVisibleCustomRoutingCount = useMemo(
    () =>
      visibleCustomRoutingAccounts.filter((account) =>
        customRoutingSelected.has(account.id),
      ).length,
    [customRoutingSelected, visibleCustomRoutingAccounts],
  );
  const allVisibleCustomRoutingSelected =
    visibleCustomRoutingAccounts.length > 0 &&
    selectedVisibleCustomRoutingCount === visibleCustomRoutingAccounts.length;

  useEffect(() => {
    if (!customRoutingSelectAllRef.current) return;
    customRoutingSelectAllRef.current.indeterminate =
      selectedVisibleCustomRoutingCount > 0 && !allVisibleCustomRoutingSelected;
  }, [allVisibleCustomRoutingSelected, selectedVisibleCustomRoutingCount]);

  const handleCopy = async (field: CopyableField, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(
        () => setCopiedField((current) => (current === field ? null : current)),
        1200,
      );
    } catch (err) {
      setError(t('common.shared.export.copyFailed', '复制失败，请手动复制'));
      console.error('Failed to copy local access value:', err);
    }
  };

  const runAction = async (task: () => Promise<void>, successText: string) => {
    setError('');
    setNotice('');
    try {
      await task();
      setNotice(successText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleSelectAllVisible = () => {
    if (actionBusy || visibleSelectableAccounts.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const account of visibleSelectableAccounts) {
          next.delete(account.id);
        }
      } else {
        for (const account of visibleSelectableAccounts) {
          next.add(account.id);
        }
      }
      return next;
    });
  };

  const handleToggleRestrictFreeAccounts = async () => {
    if (actionBusy) return;
    setRestrictFreeAccounts((prev) => !prev);
  };

  const toggleSelect = (accountId: string) => {
    if (actionBusy) return;
    const account = localAccessAccountById.get(accountId);
    if (!account) return;
    setSelected((prev) => {
      const isSelectionBlocked =
        !isCodexLocalAccessEligibleAccount(account, restrictFreeAccounts) &&
        !prev.has(accountId);
      if (isSelectionBlocked) {
        return prev;
      }
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const handleSaveMembers = async () => {
    setError('');
    setNotice('');
    try {
      const filtered = Array.from(selected).filter((accountId) => {
        const account = localAccessAccountById.get(accountId);
        if (!account) return false;
        return isCodexLocalAccessEligibleAccount(account, restrictFreeAccounts);
      });
      await onSaveAccounts({
        accountIds: filtered,
        restrictFreeAccounts,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePort = async () => {
    const nextPort = Number(portInput.trim());
    if (!Number.isInteger(nextPort) || nextPort <= 0 || nextPort > 65535) {
      setError(t('codex.localAccess.portInvalid', '请输入 1 到 65535 之间的端口'));
      return;
    }

    await runAction(
      async () => {
        await onUpdatePort(nextPort);
      },
      t('codex.localAccess.portSaveSuccess', 'API 服务端口已更新'),
    );
  };

  const handleSaveCredentials = async () => {
    const normalizedCustomCredentials = customCredentialsInput.map((credential, index) => ({
      ...credential,
      name:
        credential.name.trim() ||
        t('codex.localAccess.customProfileFallbackName', {
          index: index + 1,
          defaultValue: '自定义配置 {{index}}',
        }),
      baseUrl: credential.baseUrl.trim(),
      apiKey: credential.apiKey.trim(),
      updatedAt: Date.now(),
    }));
    const activeCredential =
      normalizedCustomCredentials.find(
        (credential) => credential.id === activeCustomCredentialOptionValue,
      ) ??
      normalizedCustomCredentials[0] ??
      null;
    const nextBaseUrl = credentialModeInput === 'cpa'
      ? cpaServiceState?.baseUrl || CODEX_CPA_SERVICE_BASE_URL
      : activeCredential?.baseUrl ?? '';
    const nextApiKey = credentialModeInput === 'cpa'
      ? cpaServiceState?.apiKey || CODEX_CPA_SERVICE_API_KEY
      : activeCredential?.apiKey ?? '';
    if (credentialModeInput === 'custom') {
      if (!activeCredential) {
        setError(
          t('codex.localAccess.customProfileRequired', '请先新增一个自定义配置'),
        );
        return;
      }
      if (!/^https?:\/\//i.test(nextBaseUrl)) {
        setError(t('codex.localAccess.customBaseUrlInvalid', '自定义 API 地址需以 http:// 或 https:// 开头'));
        return;
      }
      if (!nextApiKey) {
        setError(t('codex.localAccess.customApiKeyRequired', '请输入自定义 API 密钥'));
        return;
      }
    }

    await runAction(
      async () => {
        await onUpdateCredentials({
          credentialMode: credentialModeInput,
          activeCustomCredentialId:
            credentialModeInput === 'cpa' ? 'cpa-service' : activeCredential?.id ?? null,
          customCredentials:
            credentialModeInput === 'cpa' ? null : normalizedCustomCredentials,
          customBaseUrl: nextBaseUrl || null,
          customApiKey: nextApiKey || null,
        });
        if (credentialModeInput === 'cpa') {
          await refreshCpaServiceState();
        }
      },
      credentialModeInput === 'cpa'
        ? t('codex.localAccess.credentialsModeCpaSuccess', '已切换到 CPA 服务')
        : credentialModeInput === 'custom'
        ? t('codex.localAccess.credentialsModeCustomSuccess', '已切换到自定义配置')
        : t('codex.localAccess.credentialsModeLocalSuccess', '已切换到内置服务'),
    );
  };

  const openCustomRoutingDialog = () => {
    if (!collection) return;
    setError('');
    setNotice('');
    setCustomRoutingError('');
    setCustomRoutingOpen(true);
  };

  const handleChangeRoutingStrategy = async (nextStrategy: string) => {
    if (!collection) return;
    if (nextStrategy === 'custom') {
      openCustomRoutingDialog();
      return;
    }
    if (nextStrategy === routingStrategy) return;

    await runAction(
      async () => {
        await onUpdateRoutingStrategy(nextStrategy as CodexLocalAccessRoutingStrategy);
      },
      t('codex.localAccess.routingSaveSuccess', 'API 服务调度策略已更新'),
    );
  };

  const closeCustomRoutingDialog = () => {
    if (saving) return;
    setCustomRoutingOpen(false);
    setCustomRoutingError('');
    setCustomRoutingSelected(new Set());
  };

  const toggleCustomRoutingSelect = (accountId: string) => {
    if (saving) return;
    setCustomRoutingSelected((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const toggleCustomRoutingSelectAllVisible = () => {
    if (saving || visibleCustomRoutingAccounts.length === 0) return;
    setCustomRoutingSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleCustomRoutingSelected) {
        visibleCustomRoutingAccounts.forEach((account) => next.delete(account.id));
      } else {
        visibleCustomRoutingAccounts.forEach((account) => next.add(account.id));
      }
      return next;
    });
  };

  const updateCustomRoutingRule = (
    accountId: string,
    field: keyof CustomRoutingDraftRule,
    rawValue: string,
  ) => {
    const parsed = Number.parseInt(rawValue, 10);
    setCustomRoutingDraft((prev) => {
      const current = prev[accountId] ?? {
        priority: CUSTOM_ROUTING_PRIORITY_MIN,
        weight: CUSTOM_ROUTING_WEIGHT_MIN,
      };
      return {
        ...prev,
        [accountId]: {
          ...current,
          [field]:
            field === 'priority'
              ? normalizeCustomRoutingPriority(parsed)
              : normalizeCustomRoutingWeight(parsed),
        },
      };
    });
  };

  const applyCustomRoutingBatch = () => {
    if (saving || customRoutingSelected.size === 0) return;
    const priority = normalizeCustomRoutingPriority(
      Number.parseInt(customRoutingBulkPriority, 10),
    );
    const weight = normalizeCustomRoutingWeight(
      Number.parseInt(customRoutingBulkWeight, 10),
    );
    setCustomRoutingBulkPriority(String(priority));
    setCustomRoutingBulkWeight(String(weight));
    setCustomRoutingDraft((prev) => {
      const next = { ...prev };
      customRoutingSelected.forEach((accountId) => {
        next[accountId] = { priority, weight };
      });
      return next;
    });
  };

  const resetCustomRoutingDraft = () => {
    if (!collection || saving) return;
    const next: Record<string, CustomRoutingDraftRule> = {};
    collection.accountIds.forEach((accountId) => {
      next[accountId] = {
        priority: CUSTOM_ROUTING_PRIORITY_MIN,
        weight: CUSTOM_ROUTING_WEIGHT_MIN,
      };
    });
    setCustomRoutingDraft(next);
    setCustomRoutingSelected(new Set());
  };

  const handleSaveCustomRouting = async () => {
    if (!collection) return;
    setCustomRoutingError('');
    setNotice('');
    try {
      const rules = collection.accountIds.map((accountId) => {
        const rule = customRoutingDraft[accountId] ??
          customRoutingRuleByAccountId.get(accountId) ?? {
            priority: CUSTOM_ROUTING_PRIORITY_MIN,
            weight: CUSTOM_ROUTING_WEIGHT_MIN,
          };
        return {
          accountId,
          priority: normalizeCustomRoutingPriority(rule.priority),
          weight: normalizeCustomRoutingWeight(rule.weight),
        };
      });
      await onUpdateCustomRouting(rules);
      setNotice(
        t(
          'codex.localAccess.customRoutingSaveSuccess',
          'API 服务自定义调度已更新',
        ),
      );
      setCustomRoutingOpen(false);
      setCustomRoutingSelected(new Set());
    } catch (err) {
      setCustomRoutingError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChangeAccessScope = async (nextValue: string) => {
    if (!collection) return;
    const nextAccessScope = normalizeAccessScope(nextValue);
    if (nextAccessScope === accessScope) return;

    await runAction(
      async () => {
        await onUpdateAccessScope(nextAccessScope);
      },
      t('codex.localAccess.accessScopeSaveSuccess', 'API 服务访问范围已更新'),
    );
  };

  const handleSaveUpstreamProxyConfig = async () => {
    if (!collection) return;
    const upstreamProxyUrlDraft = upstreamProxyDraftUrl.trim();
    if (upstreamProxyUrlDraft === upstreamProxyUrl.trim()) {
      setUpstreamProxyDraftUrl(upstreamProxyUrlDraft);
      return;
    }

    await runAction(
      async () => {
        await onUpdateUpstreamProxyConfig(upstreamProxyUrlDraft || null);
      },
      t(
        'codex.localAccess.upstreamProxySaveSuccess',
        'API 代理地址已更新',
      ),
    );
  };

  const handleToggleDebugLogs = async () => {
    if (!collection) return;
    const nextDebugLogs = !collection.debugLogs;
    const confirmed = await confirmDialog(
      nextDebugLogs
        ? t(
            'codex.localAccess.debugLogsEnableConfirmMessage',
            '打开后会输出 API 服务调试日志，用于定位网关、代理、上游请求和流式响应问题。高并发或长时间流式请求时可能带来少量性能开销，建议排查完成后关闭。确认打开吗？',
          )
        : t(
            'codex.localAccess.debugLogsDisableConfirmMessage',
            '关闭后会停止输出 API 服务调试日志，减少日志噪声和额外开销；后续排查网关、代理或流式响应问题时可再次打开。确认关闭吗？',
          ),
      {
        title: nextDebugLogs
          ? t('codex.localAccess.debugLogsEnableConfirmTitle', '是否打开日志调试模式？')
          : t('codex.localAccess.debugLogsDisableConfirmTitle', '是否关闭日志调试模式？'),
        kind: 'info',
        okLabel: nextDebugLogs
          ? t('codex.localAccess.debugLogsEnableConfirmAction', '打开')
          : t('codex.localAccess.debugLogsDisableConfirmAction', '关闭'),
        cancelLabel: t('common.cancel'),
      },
    );

    if (!confirmed) {
      return;
    }

    setError('');
    setNotice('');
    try {
      await onUpdateDebugLogs(nextDebugLogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetKey = async () => {
    const confirmed = await confirmDialog(
      t(
        'codex.localAccess.rotateConfirmMessage',
        '重置后当前 API 服务密钥会立即失效，正在进行中的请求可能不可用。确认继续吗？',
      ),
      {
        title: t('codex.localAccess.rotateKey', '重置密钥'),
        kind: 'warning',
        okLabel: t('common.confirm'),
        cancelLabel: t('common.cancel'),
      },
    );

    if (!confirmed) {
      return;
    }

    await runAction(
      async () => {
        await onRotateApiKey();
        setKeyVisible(true);
      },
      t('codex.localAccess.rotateSuccess', 'API 服务密钥已重置'),
    );
  };

  const handleClearStats = async () => {
    const confirmed = await confirmDialog(
      t('codex.localAccess.clearStatsConfirm', '确定要清空 API 服务统计吗？'),
      {
        title: t('codex.localAccess.clearStats', '清除统计'),
        kind: 'warning',
        okLabel: t('common.confirm'),
        cancelLabel: t('common.cancel'),
      },
    );

    if (!confirmed) {
      return;
    }

    await runAction(async () => {
      await onClearStats();
    }, t('codex.localAccess.clearStatsSuccess', 'API 服务统计已清空'));
  };

  const handleKillPort = async () => {
    await runAction(
      async () => {
        await onKillPort();
      },
      t('codex.localAccess.killPortSuccessUnknown', 'API 服务端口已清理'),
    );
  };

  const handleRefreshStats = async () => {
    setError('');
    setNotice('');
    try {
      await onRefreshStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleEnabled = async () => {
    if (isCpaPanelMode) {
      if (cpaServiceRunning) {
        const confirmed = await confirmStopCpaService();
        if (!confirmed) return;
      }

      await runAction(
        async () => {
          if (!cpaServiceRunning && cpaServiceState && !cpaServiceState.runtimeInstalled) {
            setShowCpaServiceManager(true);
            throw new Error(
              t(
                'codex.localAccess.cpaRuntimeMissing',
                '未安装 CPA 运行时，请先下载或导入安装包。',
              ),
            );
          }
          const nextState = cpaServiceRunning
            ? await codexService.stopCodexCpaService()
            : await codexService.startCodexCpaService();
          setCpaServiceState(nextState);
          setCpaConfigDraft(nextState.configContent ?? '');
          setCpaManagementPasswordDraft(nextState.managementPassword || 'ab2026ab');
          dispatchCpaServiceStateUpdated();
        },
        cpaServiceRunning
          ? t('codex.localAccess.cpaServiceStopped', '未启动')
          : t('codex.localAccess.cpaServiceRunning', '已启动'),
      );
      return;
    }

    await runAction(
      async () => {
        await onToggleEnabled();
      },
      collection?.enabled
        ? t('codex.localAccess.disabledSuccess', 'API 服务已停用')
        : t('codex.localAccess.enabledSuccess', 'API 服务已启用'),
    );
  };

  const closeTestDialog = () => {
    if (testDialogBusy) return;
    setTestDialogOpen(false);
  };

  const handleTest = async () => {
    setTestDialogOpen(true);
    setTestDialogRunning(true);
    setTestDialogResult(null);
    setTestDialogError('');
    try {
      const result = await onTest();
      setTestDialogResult(result);
    } catch (err) {
      setTestDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestDialogRunning(false);
    }
  };

  if (!isOpen) return null;
  const testFailure = testDialogResult?.failure ?? null;
  const testSuccessResult = testDialogResult && !testFailure ? testDialogResult : null;
  const isMembersMode = mode === 'members';

  return (
    <>
      <div
        className={`modal-overlay codex-local-access-modal-overlay${
          isMembersMode ? '' : ' codex-local-access-modal-overlay-panel'
        }`}
        onClick={onClose}
      >
      <div
        className={`modal codex-local-access-modal${
          isMembersMode
            ? ' codex-local-access-modal-members group-account-picker-modal'
            : ' codex-local-access-modal-panel'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header codex-local-access-modal-header">
          <div className="codex-local-access-header-main">
            <h2 className="group-account-picker-title">
              <Server size={18} />
              <span>
                {isMembersMode
                  ? t('codex.localAccess.entryAction', '添加至 API 服务')
                  : t('codex.localAccess.title', 'API 服务')}
              </span>
            </h2>
            {!isMembersMode && (
              <div className="codex-local-access-header-meta">
                <div className="codex-local-access-header-badges">
                  <span className={`codex-local-access-status ${panelServiceStatusTone}`}>
                    {panelServiceStatusText}
                  </span>
                  {showBuiltInNetworkConfig && (
                    <span className="codex-local-access-subtle-badge">
                      {accessScopeBadge}
                    </span>
                  )}
                  <button
                    type="button"
                    className="codex-local-access-test-pill"
                    onClick={() => void handleTest()}
                    disabled={!collection || testDialogBusy || saving}
                    title={t('codex.localAccess.testDialogTitle', '测试 API 服务')}
                    aria-label={t('codex.localAccess.testDialogTitle', '测试 API 服务')}
                  >
                    <ShieldCheck size={13} className={testDialogBusy ? 'loading-spinner' : ''} />
                    <span>{t('codex.localAccess.testAction', '测试')}</span>
                  </button>
                  {collection && showBuiltInNetworkConfig && (
                    <div className="codex-local-access-header-upstream">
                      <div className="codex-local-access-header-upstream-url">
                        <input
                          type="text"
                          value={upstreamProxyDraftUrl}
                          onChange={(event) =>
                            setUpstreamProxyDraftUrl(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleSaveUpstreamProxyConfig();
                            }
                          }}
                          disabled={saving || testing || starting}
                          placeholder={t(
                            'codex.localAccess.upstreamProxyUrlPlaceholder',
                            '留空使用全局代理',
                          )}
                          aria-label={t(
                            'codex.localAccess.upstreamProxyLabel',
                            'API 代理地址',
                          )}
                        />
                        <button
                          type="button"
                          className="codex-local-access-upstream-save-btn"
                          onClick={() => void handleSaveUpstreamProxyConfig()}
                          disabled={saving || testing || starting}
                          title={t(
                            'codex.localAccess.upstreamProxySaveAction',
                            '保存代理',
                          )}
                          aria-label={t(
                            'codex.localAccess.upstreamProxySaveAction',
                            '保存代理',
                          )}
                        >
                          <Check size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="codex-local-access-header-tools">
                  {onOpenFullPage && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm codex-local-access-full-page-btn"
                      onClick={onOpenFullPage}
                      title={t('codex.apiService.openFullPage', '查看全部功能')}
                      aria-label={t('codex.apiService.openFullPage', '查看全部功能')}
                    >
                      <ExternalLink size={14} />
                      <span>{t('codex.apiService.openFullPage', '查看全部功能')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="folder-icon-btn codex-local-access-toolbar-btn"
                    onClick={() => void handleRefreshStats()}
                    disabled={!collection || actionBusy}
                    title={t('codex.localAccess.refreshStats', '刷新统计')}
                    aria-label={t('codex.localAccess.refreshStats', '刷新统计')}
                  >
                    <RefreshCw size={14} className={saving ? 'loading-spinner' : ''} />
                  </button>
                  {collection && (
                    <>
                      <div className="codex-local-access-header-routing">
                        <SingleSelectDropdown
                          value={routingStrategy}
                          options={routingStrategyOptions}
                          onChange={(value) => void handleChangeRoutingStrategy(value)}
                          disabled={saving || testing || starting}
                          ariaLabel={t('codex.localAccess.routingLabel', '调度策略')}
                        />
                      </div>
                      {routingStrategy === 'custom' && (
                        <button
                          type="button"
                          className="folder-icon-btn codex-local-access-toolbar-btn"
                          onClick={openCustomRoutingDialog}
                          disabled={saving || testing || starting}
                          title={t('codex.localAccess.customRoutingEdit', '编辑自定义调度')}
                          aria-label={t('codex.localAccess.customRoutingEdit', '编辑自定义调度')}
                        >
                          <SlidersHorizontal size={14} />
                        </button>
                      )}
                    </>
                  )}
                  {collection && (
                    <button
                      type="button"
                      className={`folder-icon-btn codex-local-access-toolbar-btn codex-local-access-debug-toggle${
                        collection.debugLogs ? ' is-active' : ''
                      }`}
                      onClick={() => void handleToggleDebugLogs()}
                      disabled={saving || testing || starting}
                      title={
                        collection.debugLogs
                          ? t('codex.localAccess.debugLogsEnabledSuccess', '调试日志已开启')
                          : t('codex.localAccess.debugLogsDisabledSuccess', '调试日志已关闭')
                      }
                      aria-label={
                        collection.debugLogs
                          ? t('codex.localAccess.debugLogsEnabledSuccess', '调试日志已开启')
                          : t('codex.localAccess.debugLogsDisabledSuccess', '调试日志已关闭')
                      }
                      aria-pressed={collection.debugLogs}
                    >
                      <Bug size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`folder-icon-btn codex-local-access-toolbar-btn ${
                      isCpaPanelMode
                        ? cpaServiceRunning
                          ? 'is-danger'
                          : 'is-primary'
                        : collection?.enabled
                        ? 'is-danger'
                        : 'is-primary'
                    }`}
                    onClick={() => void handleToggleEnabled()}
                    disabled={
                      !collection ||
                      saving ||
                      testing ||
                      starting ||
                      (isCpaPanelMode && cpaServiceBusy)
                    }
                    title={
                      isCpaPanelMode
                        ? cpaServiceRunning
                          ? t('codex.localAccess.cpaStop', '停止')
                          : t('codex.localAccess.cpaStart', '启动')
                        : collection?.enabled
                        ? t('codex.localAccess.disableService', '停用服务')
                        : t('codex.localAccess.enableService', '启用服务')
                    }
                    aria-label={
                      isCpaPanelMode
                        ? cpaServiceRunning
                          ? t('codex.localAccess.cpaStop', '停止')
                          : t('codex.localAccess.cpaStart', '启动')
                        : collection?.enabled
                        ? t('codex.localAccess.disableService', '停用服务')
                        : t('codex.localAccess.enableService', '启用服务')
                    }
                  >
                    {isCpaPanelMode && cpaServiceBusy ? (
                      <RefreshCw size={14} className="loading-spinner" />
                    ) : (
                      <Power size={14} />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            className="modal-close codex-local-access-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body codex-local-access-modal-body">
          {state?.lastError && (
            <div className="codex-local-access-inline-error codex-local-access-inline-error-with-action">
              <CircleAlert size={14} />
              <span>{state.lastError}</span>
              {collection && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm codex-local-access-inline-action"
                  onClick={() => void handleKillPort()}
                  disabled={actionBusy}
                >
                  {portCleanupBusy ? (
                    <RefreshCw size={14} className="loading-spinner" />
                  ) : (
                    <Wrench size={14} />
                  )}
                  {t('codex.localAccess.killPortAction', '清理端口')}
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="codex-local-access-inline-error">
              <CircleAlert size={14} />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="codex-local-access-inline-success">
              <Check size={14} />
              <span>{notice}</span>
            </div>
          )}

          {!isMembersMode && (
            <section className="codex-local-access-section codex-local-access-section-surface codex-local-access-summary-block">
              <div className="codex-local-access-summary-head">
                <div className="codex-local-access-section-title">
                  <Activity size={16} />
                  <span>{t('codex.localAccess.statsTitle', '总量统计')}</span>
                </div>
                <div className="codex-local-access-summary-actions">
                  <div
                    className="codex-local-access-stats-range-tabs"
                    role="tablist"
                    aria-label={t('codex.localAccess.statsRange.label', '统计范围')}
                  >
                    {statsRangeOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        role="tab"
                        className={`codex-local-access-stats-range-tab${
                          statsRange === option.key ? ' is-active' : ''
                        }`}
                        aria-selected={statsRange === option.key}
                        onClick={() => setStatsRange(option.key)}
                        disabled={actionBusy}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => void handleClearStats()}
                    disabled={!collection || actionBusy}
                    title={t('codex.localAccess.clearStats', '清除统计')}
                    aria-label={t('codex.localAccess.clearStats', '清除统计')}
                  >
                    <Trash2 size={14} />
                    {t('codex.localAccess.clearStats', '清除统计')}
                  </button>
                </div>
              </div>
              <div className="codex-local-access-stats-grid">
                {summaryStats.map((item) => (
                  <div
                    key={item.key}
                    className={`codex-local-access-stat-card codex-local-access-stat-card-${item.key}`}
                  >
                    <span className="codex-local-access-stat-label">{item.label}</span>
                    <strong>{item.value}</strong>
                    <span className="codex-local-access-stat-sub">{item.detail}</span>
                  </div>
                ))}
              </div>
              {currentQuotaPoolSummary.visiblePlans.length > 0 && (
                <div
                  className="codex-local-access-quota-pool-grid"
                  aria-label={quotaPoolLabels.title}
                >
                  {currentQuotaPoolSummary.visiblePlans.map((item) => (
                    <div key={item.key} className="codex-local-access-quota-pool-card">
                      <span className="codex-local-access-quota-pool-plan">
                        {item.key} ({item.count})
                      </span>
                      <span className="codex-local-access-quota-pool-value">
                        {quotaPoolLabels.hourly} {formatCodexQuotaPoolPercent(item.hourly)}
                      </span>
                      <span className="codex-local-access-quota-pool-value">
                        {quotaPoolLabels.weekly} {formatCodexQuotaPoolPercent(item.weekly)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {!isMembersMode && (
            <div className="codex-local-access-panel-grid">
              <section className="codex-local-access-section codex-local-access-section-surface codex-local-access-config-section">
                <div className="codex-local-access-section-title">
                  <KeyRound size={16} />
                  <span>{t('codex.localAccess.configTitle', '服务配置')}</span>
                </div>
                {collection ? (
                  <div className="codex-local-access-config-grid">
                    <div className="codex-local-access-config-card codex-local-access-config-card-mode">
                      <div className="codex-local-access-config-head">
                        <span className="codex-local-access-config-label">
                          {t('codex.localAccess.credentialModeLabel', '运行配置')}
                        </span>
                        <div className="codex-local-access-config-actions">
                          {isCpaCredentialDraftMode && (
                            <>
                              <span className={`codex-local-access-cpa-service-chip ${cpaServiceStateTone}`}>
                                {cpaServiceStateText}
                              </span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => void handleOpenCpaServiceManager()}
                                disabled={saving || testing || starting || cpaServiceLoading}
                              >
                                <Server size={14} />
                                {t('codex.localAccess.cpaManage', 'CPA管理')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm codex-local-access-cpa-stop-btn"
                                onClick={() => void handleStopCpaService()}
                                disabled={
                                  saving ||
                                  testing ||
                                  starting ||
                                  cpaServiceBusy ||
                                  cpaServiceLoading ||
                                  !cpaServiceRunning
                                }
                              >
                                {cpaServiceBusy ? (
                                  <RefreshCw size={14} className="loading-spinner" />
                                ) : (
                                  <Power size={14} />
                                )}
                                {t('codex.localAccess.cpaStop', '停止')}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void handleSaveCredentials()}
                            disabled={saving || testing || starting}
                          >
                            {saving ? (
                              <RefreshCw size={14} className="loading-spinner" />
                            ) : (
                              <KeyRound size={14} />
                            )}
                            {t('codex.localAccess.credentialsSave', '保存配置')}
                          </button>
                        </div>
                      </div>
                      <SingleSelectDropdown
                        value={credentialModeInput}
                        options={credentialModeOptions}
                        onChange={handleCredentialModeInputChange}
                        menuClassName="codex-local-access-credential-mode-menu"
                        menuWidth={148}
                        menuMaxHeight={120}
                        disabled={saving || testing || starting}
                        ariaLabel={t('codex.localAccess.credentialModeLabel', '运行配置')}
                      />
                    </div>

                    <div className="codex-local-access-config-card codex-local-access-config-card-base">
                      <div className="codex-local-access-config-head">
                        <div className="codex-local-access-config-label codex-local-access-address-select">
                          <SingleSelectDropdown
                            value={addressKind}
                            options={addressOptions}
                            onChange={onAddressKindChange}
                            menuClassName="codex-local-access-address-menu"
                            menuWidth={104}
                            menuMaxHeight={156}
                            disabled={addressOptions.length < 2}
                            ariaLabel={t('codex.localAccess.addressKind', '地址类型')}
                          />
                        </div>
                        <div className="codex-local-access-config-actions">
                          <button
                            type="button"
                            className="folder-icon-btn"
                            onClick={() => void handleCopy('baseUrl', activeBaseUrl)}
                            title={t('common.copy', '复制')}
                            disabled={!activeBaseUrl}
                          >
                            {copiedField === 'baseUrl' ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                      <code className="codex-local-access-code" title={activeBaseUrl}>
                        {activeBaseUrl || '-'}
                      </code>
                    </div>

                    <div className="codex-local-access-config-card codex-local-access-config-card-key">
                      <div className="codex-local-access-config-head">
                        <span className="codex-local-access-config-label">
                          {t('codex.localAccess.apiKey', '密钥')}
                        </span>
                        <div className="codex-local-access-config-actions">
                          <button
                            type="button"
                            className="folder-icon-btn"
                            onClick={() => setKeyVisible((prev) => !prev)}
                            title={
                              keyVisible
                                ? t('codex.localAccess.hideKey', '隐藏密钥')
                                : t('codex.localAccess.showKey', '显示密钥')
                            }
                          >
                            {keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button
                            type="button"
                            className="folder-icon-btn"
                            onClick={() => void handleCopy('apiKey', activeApiKey)}
                            title={t('common.copy', '复制')}
                            disabled={!activeApiKey}
                          >
                            {copiedField === 'apiKey' ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void handleResetKey()}
                            disabled={
                              saving ||
                              testing ||
                              starting ||
                              isExternalCredentialMode ||
                              isExternalCredentialDraftMode
                            }
                          >
                            {saving ? (
                              <RefreshCw size={14} className="loading-spinner" />
                            ) : (
                              <RefreshCw size={14} />
                            )}
                            {t('codex.localAccess.rotateKey', '重置密钥')}
                          </button>
                        </div>
                      </div>
                      <code className="codex-local-access-code" title={activeApiKey || '-'}>
                        {keyVisible
                          ? activeApiKey || '-'
                          : activeApiKey
                            ? `${activeApiKey.slice(0, 10)}••••••••••••`
                            : '-'}
                      </code>
                    </div>

                    {isCustomCredentialDraftMode && (
                    <div className="codex-local-access-config-card codex-local-access-config-card-custom">
                      <div className="codex-local-access-config-head">
                        <span className="codex-local-access-config-label">
                          {t('codex.localAccess.customEndpointLabel', '自定义配置')}
                        </span>
                        <div className="codex-local-access-config-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={handleAddCustomCredential}
                            disabled={saving || testing || starting}
                          >
                            <FolderPlus size={14} />
                            {t('codex.localAccess.customProfileAdd', '新增')}
                          </button>
                          <button
                            type="button"
                            className="folder-icon-btn"
                            onClick={handleRemoveActiveCustomCredential}
                            title={t('codex.localAccess.customProfileRemove', '删除当前配置')}
                            aria-label={t('codex.localAccess.customProfileRemove', '删除当前配置')}
                            disabled={
                              saving ||
                              testing ||
                              starting ||
                              !activeCustomCredentialInput
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="codex-local-access-custom-profile-row">
                        <SingleSelectDropdown
                          value={activeCustomCredentialOptionValue}
                          options={customCredentialOptions}
                          onChange={setActiveCustomCredentialIdInput}
                          placeholder={t('codex.localAccess.customProfileEmpty', '暂无自定义配置')}
                          menuClassName="codex-local-access-custom-profile-menu"
                          menuWidth={240}
                          menuMaxHeight={220}
                          disabled={
                            saving ||
                            testing ||
                            starting ||
                            customCredentialOptions.length === 0
                          }
                          ariaLabel={t('codex.localAccess.customProfileSelect', '选择自定义配置')}
                        />
                        <input
                          type="text"
                          value={activeCustomCredentialInput?.name ?? ''}
                          onChange={(event) =>
                            updateActiveCustomCredentialInput({ name: event.target.value })
                          }
                          placeholder={t('codex.localAccess.customProfileNamePlaceholder', '配置名称')}
                          disabled={saving || testing || starting}
                        />
                      </div>
                      <div className="codex-local-access-custom-fields">
                        <input
                          type="url"
                          value={activeCustomCredentialInput?.baseUrl ?? ''}
                          onChange={(event) =>
                            updateActiveCustomCredentialInput({ baseUrl: event.target.value })
                          }
                          placeholder="https://api.example.com/v1"
                          disabled={saving || testing || starting || !activeCustomCredentialInput}
                        />
                        <input
                          type={customApiKeyVisible ? 'text' : 'password'}
                          value={activeCustomCredentialInput?.apiKey ?? ''}
                          onChange={(event) =>
                            updateActiveCustomCredentialInput({ apiKey: event.target.value })
                          }
                          placeholder={t('codex.localAccess.customApiKeyPlaceholder', '自定义 API 密钥')}
                          disabled={saving || testing || starting || !activeCustomCredentialInput}
                        />
                        <button
                          type="button"
                          className="folder-icon-btn codex-local-access-custom-key-toggle"
                          onClick={() => setCustomApiKeyVisible((prev) => !prev)}
                          title={
                            customApiKeyVisible
                              ? t('codex.localAccess.hideKey', '隐藏密钥')
                              : t('codex.localAccess.showKey', '显示密钥')
                          }
                          disabled={saving || testing || starting || !activeCustomCredentialInput}
                        >
                          {customApiKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                    )}

                    {showBuiltInNetworkConfig && (
                    <div className="codex-local-access-config-card codex-local-access-config-card-port codex-local-access-port-card">
                      <div className="codex-local-access-config-head">
                        <label
                          className="codex-local-access-config-label"
                          htmlFor="codex-local-access-port"
                        >
                          {t('codex.localAccess.portLabel', '服务端口')}
                        </label>
                        <div className="codex-local-access-config-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void handleSavePort()}
                            disabled={saving || testing || starting}
                          >
                            {saving ? (
                              <RefreshCw size={14} className="loading-spinner" />
                            ) : (
                              <Gauge size={14} />
                            )}
                            {t('codex.localAccess.portSave', '保存端口')}
                          </button>
                        </div>
                      </div>
                      <div className="codex-local-access-port-row">
                        <input
                          id="codex-local-access-port"
                          type="number"
                          min={1}
                          max={65535}
                          value={portInput}
                          onChange={(event) => setPortInput(event.target.value)}
                          disabled={saving || testing || starting}
                        />
                      </div>
                    </div>
                    )}

                    {showBuiltInNetworkConfig && (
                    <div className="codex-local-access-config-card codex-local-access-config-card-scope">
                      <div className="codex-local-access-config-head">
                        <span className="codex-local-access-config-label">
                          {t('codex.localAccess.accessScopeLabel', '访问范围')}
                        </span>
                        <div className="codex-local-access-config-actions">
                          <SingleSelectDropdown
                            value={accessScope}
                            options={accessScopeOptions}
                            onChange={(value) => void handleChangeAccessScope(value)}
                            menuClassName="codex-local-access-scope-menu"
                            menuWidth={132}
                            menuMaxHeight={120}
                            disabled={saving || testing || starting}
                            ariaLabel={t('codex.localAccess.accessScopeLabel', '访问范围')}
                          />
                        </div>
                      </div>
                      <code className="codex-local-access-code" title={accessScopeAddress}>
                        {accessScopeAddress}
                      </code>
                    </div>
                    )}

                  </div>
                ) : (
                  <div className="group-account-empty">
                    {t(
                      'codex.localAccess.configEmpty',
                      '先把账号保存到 API 服务集合，随后会自动生成地址、密钥和端口。',
                    )}
                  </div>
                )}
                {collection || modelIdOptions.length > 0 ? (
                  <div className="codex-local-access-config-extra-grid">
                    {collection && showBuiltInNetworkConfig ? (
                      <div className="codex-local-access-config-card codex-local-access-config-card-root">
                        <div className="codex-local-access-config-head">
                          <span className="codex-local-access-config-label">
                            {t('codex.localAccess.apiPortUrl', 'API端口URL')}
                          </span>
                          <div className="codex-local-access-config-actions">
                            <button
                              type="button"
                              className="folder-icon-btn"
                              onClick={() => void handleCopy('apiPortUrl', apiPortUrl)}
                              title={t('common.copy', '复制')}
                            >
                              {copiedField === 'apiPortUrl' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </div>
                        <code className="codex-local-access-code" title={apiPortUrl}>
                          {apiPortUrl}
                        </code>
                      </div>
                    ) : null}

                    {modelIdOptions.length > 0 ? (
                      <div className="codex-local-access-config-card codex-local-access-config-card-model">
                        <div className="codex-local-access-config-head">
                          <span className="codex-local-access-config-label">
                            {t('codex.localAccess.modelId', '模型 ID')}
                          </span>
                          <div className="codex-local-access-config-actions">
                            {isExternalCredentialPanelMode && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => void handleFetchExternalModels()}
                                disabled={!activeBaseUrl || externalModelsLoading}
                              >
                                <RefreshCw
                                  size={14}
                                  className={externalModelsLoading ? 'loading-spinner' : undefined}
                                />
                                {t('codex.localAccess.fetchModels', '获取模型列表')}
                              </button>
                            )}
                            <span className="codex-local-access-view-only-badge">
                              {t('codex.localAccess.modelIdViewOnly', '仅查看使用，无切换功能')}
                            </span>
                            <button
                              type="button"
                              className="folder-icon-btn"
                              onClick={() => void handleCopy('modelId', selectedModelId)}
                              title={t('common.copy', '复制')}
                              disabled={!selectedModelId}
                            >
                              {copiedField === 'modelId' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </div>
                        <div className="codex-local-access-model-row">
                          <SingleSelectDropdown
                            value={selectedModelId}
                            options={modelIdOptions}
                            onChange={setSelectedModelId}
                            disabled={modelIdOptions.length === 0}
                            ariaLabel={t('codex.localAccess.modelId', '模型 ID')}
                            placeholder={t('codex.localAccess.modelIdPlaceholder', '选择模型 ID')}
                            menuPlacement="up"
                            menuMaxHeight={240}
                          />
                        </div>
                      </div>
                    ) : isExternalCredentialPanelMode ? (
                      <div className="codex-local-access-config-card codex-local-access-config-card-model">
                        <div className="codex-local-access-config-head">
                          <span className="codex-local-access-config-label">
                            {t('codex.localAccess.modelId', '模型 ID')}
                          </span>
                          <div className="codex-local-access-config-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void handleFetchExternalModels()}
                              disabled={!activeBaseUrl || externalModelsLoading}
                            >
                              <RefreshCw
                                size={14}
                                className={externalModelsLoading ? 'loading-spinner' : undefined}
                              />
                              {t('codex.localAccess.fetchModels', '获取模型列表')}
                            </button>
                          </div>
                        </div>
                        <div className="group-account-empty">
                          {t('codex.localAccess.externalModelsEmpty', '点击获取模型列表读取当前服务的 /models。')}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="codex-local-access-section codex-local-access-section-surface codex-local-access-account-stats-section">
                <div className="codex-local-access-section-title">
                  <Server size={16} />
                  <span>{t('codex.localAccess.accountStatsTitle', '按账号统计')}</span>
                </div>
                <div className="codex-local-access-account-stats">
                  {currentMemberStats.length === 0 ? (
                    <div className="group-account-empty">
                      {t('codex.localAccess.statsEmpty', '当前还没有统计数据')}
                    </div>
                  ) : (
                    currentMemberStats.map(({ account, presentation, stats: accountStats }) => (
                      <div key={account.id} className="codex-local-access-account-stat-row">
                        <div className="codex-local-access-account-stat-top">
                          <div className="codex-local-access-account-stat-main">
                            <span
                              className="group-account-email"
                              title={maskAccountText(presentation.displayName)}
                            >
                              {maskAccountText(presentation.displayName)}
                            </span>
                            <CodexPlanBadge
                              planClass={presentation.planClass}
                              planLabel={presentation.planLabel}
                              preferences={planBadgeStylePreferences}
                            />
                          </div>
                          <div className="codex-local-access-account-stat-block codex-local-access-account-stat-block-quota">
                            {renderQuotaPreview(presentation, 3)}
                          </div>
                          <div className="codex-local-access-account-stat-block codex-local-access-account-stat-block-metrics">
                            <div className="codex-local-access-account-stat-metrics">
                              <span className="codex-local-access-account-stat-pill">
                                {formatRequestResultDetail(accountStats)}
                              </span>
                              <span className="codex-local-access-account-stat-pill">
                                {(accountStats?.totalTokens ?? 0) === 0
                                  ? t('codex.localAccess.stats.accountTokens', {
                                      count: 0,
                                      defaultValue: '0 Tokens',
                                    })
                                  : t('codex.localAccess.stats.accountTokensCompact', {
                                      value: formatCompactNumber(accountStats?.totalTokens ?? 0),
                                      defaultValue: '{{value}}',
                                    })}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

            </div>
          )}

          {isMembersMode && (
            <section className="codex-local-access-section codex-local-access-section-surface codex-local-access-member-section">
              <div className="codex-local-access-section-head">
                <div className="codex-local-access-section-title">
                  <FolderPlus size={16} />
                  <span>{t('codex.localAccess.memberTitle', '集合成员')}</span>
                </div>
                <label className="codex-local-access-free-toggle">
                  <input
                    type="checkbox"
                    checked={restrictFreeAccounts}
                    onChange={() => void handleToggleRestrictFreeAccounts()}
                    disabled={actionBusy}
                  />
                  <span>
                    {t(
                      'codex.localAccess.modal.restrictFreeToggle',
                      '限制 Free 账号使用',
                    )}
                  </span>
                </label>
              </div>

              <div className="group-account-toolbar">
                <div className="group-account-search">
                  <Search size={16} className="group-account-search-icon" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('accounts.search')}
                  />
                </div>
                <div className="group-account-picker-filters">
                  <MultiSelectFilterDropdown
                    options={tierFilterOptions}
                    selectedValues={filterTypes}
                    allLabel={allTierFilterLabel}
                    filterLabel={t('common.shared.filterLabel', '筛选')}
                    clearLabel={t('accounts.clearFilter', '清空筛选')}
                    emptyLabel={t('common.none', '暂无')}
                    ariaLabel={t('common.shared.filterLabel', '筛选')}
                    onToggleValue={(value) =>
                      setFilterTypes((prev) =>
                        prev.includes(value)
                          ? prev.filter((item) => item !== value)
                          : [...prev, value],
                      )
                    }
                    onClear={() => setFilterTypes([])}
                  />
                  <AccountTagFilterDropdown
                    availableTags={availableTags}
                    selectedTags={tagFilter}
                    onToggleTag={(value) =>
                      setTagFilter((prev) =>
                        prev.includes(value)
                          ? prev.filter((item) => item !== value)
                          : [...prev, value],
                      )
                    }
                    onClear={() => setTagFilter([])}
                  />
                  <MultiSelectFilterDropdown
                    options={groupFilterOptions}
                    selectedValues={groupFilter}
                    allLabel={t('accounts.groups.allGroups', '全部分组')}
                    filterLabel={t('accounts.groups.manageTitle', '分组管理')}
                    clearLabel={t('accounts.clearFilter', '清空筛选')}
                    emptyLabel={t('common.none', '暂无')}
                    ariaLabel={t('accounts.groups.manageTitle', '分组管理')}
                    onToggleValue={(value) =>
                      setGroupFilter((prev) =>
                        prev.includes(value)
                          ? prev.filter((item) => item !== value)
                          : [...prev, value],
                      )
                    }
                    onClear={() => setGroupFilter([])}
                  />
                </div>
              </div>

              <div className="group-account-item group-account-item-header">
                <input
                  ref={selectAllCheckboxRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                  disabled={actionBusy || visibleSelectableAccounts.length === 0}
                />
                <div className="group-account-main" />
              </div>

              <div className="group-account-list codex-local-access-member-list">
                {localAccessAccounts.length === 0 ? (
                  <div className="group-account-empty">
                    {t('codex.localAccess.modal.empty', '暂无可加入的 Codex 账号')}
                  </div>
                ) : visibleSelectableAccounts.length === 0 ? (
                  <div className="group-account-empty">
                    {t('common.shared.noMatch.title', '没有匹配的账号')}
                  </div>
                ) : (
                  visibleSelectableAccounts.map((account) => {
                    const presentation = buildCodexAccountPresentation(account, t);
                    const isChecked = selected.has(account.id);
                    const accountStats = allStatsByAccountId.get(account.id)?.usage;

                    return (
                      <label
                        key={account.id}
                        className={`group-account-item${isChecked ? ' is-current' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={actionBusy}
                          onChange={() => toggleSelect(account.id)}
                        />
                        <div className="group-account-main">
                        <div className="codex-local-access-member-mainline">
                          <span
                            className="group-account-email"
                            title={maskAccountText(presentation.displayName)}
                          >
                              {maskAccountText(presentation.displayName)}
                            </span>
                          <CodexPlanBadge
                            planClass={presentation.planClass}
                            planLabel={presentation.planLabel}
                            preferences={planBadgeStylePreferences}
                          />
                          <span className="codex-local-access-member-metric">
                            {t('codex.localAccess.stats.accountRequests', {
                              count: accountStats?.requestCount ?? 0,
                              defaultValue: '{{count}} 次请求',
                            })}
                          </span>
                          {renderQuotaPreview(presentation, 2)}
                        </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </section>
          )}
        </div>

        <div className="modal-footer group-account-picker-footer codex-local-access-modal-footer">
          {isMembersMode ? (
            <>
              <button className="btn btn-secondary" onClick={onClose} disabled={actionBusy}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleSaveMembers()}
                disabled={actionBusy || !selectionDirty}
              >
                {saving ? t('common.saving') : t('codex.localAccess.modal.save', '保存集合')}
              </button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={onClose} disabled={actionBusy}>
              {t('common.close')}
            </button>
          )}
        </div>
              </div>
              </div>

              {showCpaServiceManager && (
                <div
                  className="modal-overlay codex-cpa-service-manager-overlay"
                  onClick={() => setShowCpaServiceManager(false)}
                >
                  <div
                    className="modal codex-cpa-service-manager-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="codex-cpa-service-manager-title"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="modal-header codex-cpa-service-manager-header">
                      <div>
                        <h3 id="codex-cpa-service-manager-title">
                          <Server size={18} />
                          <span>
                            {t('codex.localAccess.cpaServiceManagerTitle', 'CPA 服务管理')}
                          </span>
                        </h3>
                        <p>{cpaServiceStateText}</p>
                      </div>
                      <button
                        className="modal-close"
                        onClick={() => setShowCpaServiceManager(false)}
                        aria-label={t('common.close')}
                      >
                        <X size={18} />
                      </button>
                    </div>

                    <div className="modal-body codex-cpa-service-manager-body">
                      {cpaServiceError && (
                        <div className="codex-local-access-inline-error" aria-live="assertive">
                          <CircleAlert size={14} />
                          <span>{cpaServiceError}</span>
                        </div>
                      )}
                      {cpaServiceState && !cpaServiceState.runtimeInstalled && (
                        <div className="codex-local-access-inline-info">
                          <Download size={14} />
                          <span>
                            {t(
                              'codex.localAccess.cpaRuntimeMissing',
                              '未安装 CPA 运行时，请先下载或导入安装包。',
                            )}
                          </span>
                        </div>
                      )}

                      <div className="codex-cpa-service-manager-grid">
                        <div className="codex-cpa-service-manager-field">
                          <span>{t('codex.localAccess.cpaServiceStatus', '服务状态')}</span>
                          <strong className={`codex-local-access-cpa-service-chip ${cpaServiceStateTone}`}>
                            {cpaServiceStateText}
                          </strong>
                        </div>
                        <div className="codex-cpa-service-manager-field">
                          <span>{t('codex.localAccess.cpaRuntimeVersion', '运行时版本')}</span>
                          <strong>{cpaServiceState?.runtimeVersion || '-'}</strong>
                        </div>
                        <div className="codex-cpa-service-manager-field">
                          <span>{t('codex.localAccess.cpaServicePid', 'PID')}</span>
                          <strong>{cpaServiceState?.pid ?? '-'}</strong>
                        </div>
                        <div className="codex-cpa-service-manager-field">
                          <span>{t('codex.localAccess.cpaWebPort', 'Web 端口')}</span>
                          <strong>{cpaServiceState?.port ?? 8317}</strong>
                        </div>
                        <div className="codex-cpa-service-manager-field is-wide">
                          <span>{t('codex.localAccess.cpaManagementUrl', '管理地址')}</span>
                          <code>{cpaServiceState?.managementUrl || 'http://127.0.0.1:8317/management.html'}</code>
                        </div>
                        <div className="codex-cpa-service-manager-field is-wide">
                          <span>{t('codex.localAccess.cpaAuthDir', '认证目录')}</span>
                          <code>{cpaServiceState?.authDir || '-'}</code>
                        </div>
                        <div className="codex-cpa-service-manager-field is-wide">
                          <span>{t('codex.localAccess.cpaRuntimeDir', '运行时目录')}</span>
                          <code>{cpaServiceState?.runtimePath || '-'}</code>
                        </div>
                        <div className="codex-cpa-service-manager-field is-wide">
                          <span>{t('codex.localAccess.cpaConfigPath', '配置文件')}</span>
                          <code>{cpaServiceState?.configPath || '-'}</code>
                        </div>
                      </div>

                      <div className="codex-cpa-service-manager-config">
                        <div className="codex-cpa-service-manager-section-head">
                          <div className="codex-local-access-test-section-title">
                            {t('codex.localAccess.cpaConfigContent', '配置内容')}
                          </div>
                          <div className="codex-cpa-service-manager-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void refreshCpaServiceState()}
                              disabled={cpaServiceLoading || cpaRuntimeBusy}
                            >
                              <RefreshCw
                                size={14}
                                className={cpaServiceLoading ? 'loading-spinner' : undefined}
                              />
                              {t('common.reload', '重载')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void handleRestoreCpaConfig()}
                              disabled={cpaRuntimeBusy || cpaServiceBusy}
                            >
                              {t('codex.localAccess.cpaRestoreDefault', '恢复默认')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => void handleSaveCpaConfig()}
                              disabled={cpaRuntimeBusy || cpaServiceBusy}
                            >
                              <Check size={14} />
                              {t('common.save', '保存')}
                            </button>
                          </div>
                        </div>
                        <div className="codex-cpa-service-config-form">
                          <label>
                            <span>{t('codex.localAccess.cpaWebPort', 'Web 端口')}</span>
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              value={cpaConfigPortInput}
                              onChange={(event) =>
                                setCpaConfigDraft((current) =>
                                  replaceYamlScalar(current, 'port', event.target.value),
                                )
                              }
                            />
                          </label>
                          <label>
                            <span>{t('codex.localAccess.cpaManagementPassword', '本机管理密钥')}</span>
                            <input
                              type="text"
                              value={cpaManagementPasswordDraft}
                              onChange={(event) =>
                                setCpaManagementPasswordDraft(event.target.value)
                              }
                            />
                          </label>
                          <label className="codex-cpa-service-config-url">
                            <span>{t('codex.localAccess.cpaManagementUrl', '管理地址')}</span>
                            <button
                              type="button"
                              className="codex-cpa-service-manager-url-btn"
                              onClick={() =>
                                void openUrl(
                                  cpaServiceState?.managementUrl ||
                                    'http://127.0.0.1:8317/management.html',
                                )
                              }
                            >
                              <ExternalLink size={14} />
                              <span>{cpaServiceState?.managementUrl || 'http://127.0.0.1:8317/management.html'}</span>
                            </button>
                          </label>
                        </div>
                        <textarea
                          value={cpaConfigDraft}
                          onChange={(event) => setCpaConfigDraft(event.target.value)}
                          spellCheck={false}
                          wrap="soft"
                        />
                      </div>

                      <div className="codex-cpa-service-manager-runtime">
                        <div className="codex-cpa-service-manager-section-head">
                          <div className="codex-local-access-test-section-title">
                            {t('codex.localAccess.cpaInstalledVersions', '已安装版本')}
                            <span>{cpaServiceState?.installedRuntimes.length ?? 0}</span>
                          </div>
                          <div className="codex-cpa-service-manager-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void openUrl(cpaServiceState?.sourceUrl || 'https://github.com/router-for-me/CLIProxyAPI')}
                            >
                              <ExternalLink size={14} />
                              {t('codex.localAccess.cpaSourceUrl', '源码地址')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void openUrl(cpaUpdateInfo?.downloadUrl || cpaServiceState?.releasesUrl || 'https://github.com/router-for-me/CLIProxyAPI/releases')}
                            >
                              <ExternalLink size={14} />
                              {t('codex.localAccess.cpaDownloadUrl', '下载地址')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void handleCheckCpaUpdate()}
                              disabled={cpaRuntimeBusy}
                            >
                              <RefreshCw
                                size={14}
                                className={cpaRuntimeBusy ? 'loading-spinner' : undefined}
                              />
                              {t('codex.localAccess.cpaCheckUpdate', '检测更新')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => void handleDownloadLatestCpaRuntime()}
                              disabled={cpaRuntimeBusy}
                            >
                              <Download size={14} />
                              {t('codex.localAccess.cpaDownloadImport', '下载导入')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void handleImportCpaRuntime()}
                              disabled={cpaRuntimeBusy}
                            >
                              <FolderPlus size={14} />
                              {t('codex.localAccess.cpaImportPackage', '导入文件')}
                            </button>
                          </div>
                        </div>
                        {cpaUpdateInfo && (
                          <div className="codex-cpa-service-update-line">
                            <span>
                              {t('codex.localAccess.cpaLatestVersion', '最新版本')}: {cpaUpdateInfo.latestVersion || '-'}
                            </span>
                            <span>
                              {cpaUpdateInfo.updateAvailable
                                ? t('codex.localAccess.cpaUpdateAvailable', '有可用更新')
                                : t('codex.localAccess.cpaAlreadyLatest', '已是最新')}
                            </span>
                            <code>{cpaUpdateInfo.assetName || '-'}</code>
                          </div>
                        )}
                        <div className="codex-cpa-service-runtime-table">
                          <div className="codex-cpa-service-runtime-row is-head">
                            <span>{t('codex.localAccess.cpaRuntimeVersion', '版本')}</span>
                            <span>{t('codex.localAccess.cpaRuntimePlatform', '平台')}</span>
                            <span>{t('codex.localAccess.cpaRuntimeImportedAt', '导入时间')}</span>
                            <span>{t('codex.localAccess.cpaRuntimePackage', '包文件')}</span>
                            <span>{t('codex.localAccess.cpaRuntimeStatus', '状态')}</span>
                          </div>
                          {(cpaServiceState?.installedRuntimes ?? []).length === 0 ? (
                            <div className="codex-cpa-service-runtime-empty">
                              {t('codex.localAccess.cpaRuntimeEmpty', '暂无已安装 CPA 运行时')}
                            </div>
                          ) : (
                            cpaServiceState?.installedRuntimes.map((runtime) => (
                              <div key={`${runtime.version}-${runtime.path}`} className="codex-cpa-service-runtime-row">
                                <strong>{runtime.version}</strong>
                                <span>{runtime.platform}</span>
                                <span>{formatCpaDateTime(runtime.importedAt)}</span>
                                <code>{runtime.packageName || '-'}</code>
                                <span className={`codex-local-access-cpa-service-chip ${runtime.current ? 'running' : 'stopped'}`}>
                                  {runtime.current
                                    ? t('codex.localAccess.cpaRuntimeCurrent', '当前')
                                    : t('common.installed', '已安装')}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="modal-footer codex-cpa-service-manager-footer">
                      <button
                        className="btn btn-secondary"
                        onClick={() => void refreshCpaServiceState()}
                        disabled={cpaServiceLoading || cpaServiceBusy}
                      >
                        <RefreshCw
                          size={14}
                          className={cpaServiceLoading ? 'loading-spinner' : undefined}
                        />
                        {t('common.refresh', '刷新')}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => void handleStartCpaService()}
                        disabled={cpaServiceBusy || cpaServiceRunning}
                      >
                        {cpaServiceBusy ? (
                          <RefreshCw size={14} className="loading-spinner" />
                        ) : (
                          <Play size={14} />
                        )}
                        {t('codex.localAccess.cpaStart', '启动')}
                      </button>
                      <button
                        className="btn btn-secondary codex-local-access-cpa-stop-btn"
                        onClick={() => void handleStopCpaService()}
                        disabled={cpaServiceBusy || !cpaServiceRunning}
                      >
                        {cpaServiceBusy ? (
                          <RefreshCw size={14} className="loading-spinner" />
                        ) : (
                          <Power size={14} />
                        )}
                        {t('codex.localAccess.cpaStop', '停止')}
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setShowCpaServiceManager(false)}
                      >
                        {t('common.close')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {customRoutingOpen && collection && (
                <div
                  className="modal-overlay codex-local-access-custom-routing-overlay"
                  onClick={closeCustomRoutingDialog}
                >
                  <div
                    className="modal codex-local-access-custom-routing-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="codex-local-access-custom-routing-title"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="modal-header codex-local-access-custom-routing-header">
                      <div>
                        <h3 id="codex-local-access-custom-routing-title">
                          <SlidersHorizontal size={18} />
                          <span>{t('codex.localAccess.customRoutingTitle', '自定义调度')}</span>
                        </h3>
                        <p>
                          {t(
                            'codex.localAccess.customRoutingDesc',
                            '按账号设置优先级和权重，用于控制 API 服务选择账号的顺序和同级负载分配。',
                          )}
                        </p>
                      </div>
                      <button
                        className="modal-close codex-local-access-custom-routing-close"
                        onClick={closeCustomRoutingDialog}
                        disabled={saving}
                        aria-label={t('common.close')}
                      >
                        <X size={18} />
                      </button>
                    </div>

            <div className="modal-body codex-local-access-custom-routing-body">
              {customRoutingError && (
                <div className="codex-local-access-inline-error" aria-live="assertive">
                  <CircleAlert size={14} />
                  <span>{customRoutingError}</span>
                </div>
              )}

              <div className="codex-local-access-custom-routing-guide">
                        <div className="codex-local-access-custom-routing-guide-card">
                          <strong>
                            {t('codex.localAccess.customRoutingPriorityTitle', '优先级')}
                          </strong>
                          <span>
                            {t(
                              'codex.localAccess.customRoutingPriorityDesc',
                              '数值越高越先被选中；高优先级账号不可用时，才会继续尝试低优先级账号。',
                            )}
                          </span>
                        </div>
                        <div className="codex-local-access-custom-routing-guide-card">
                          <strong>
                            {t('codex.localAccess.customRoutingWeightTitle', '权重')}
                          </strong>
                          <span>
                            {t(
                              'codex.localAccess.customRoutingWeightDesc',
                              '相同优先级内用于负载均衡；权重越高，分到的请求越多。',
                            )}
                          </span>
                        </div>
                      </div>

                      <div className="codex-local-access-custom-routing-toolbar">
                        <div className="group-account-search codex-local-access-custom-routing-search">
                          <Search size={16} className="group-account-search-icon" />
                          <input
                            type="text"
                            value={customRoutingQuery}
                            onChange={(event) => setCustomRoutingQuery(event.target.value)}
                            placeholder={t(
                              'codex.localAccess.customRoutingSearch',
                              '搜索邮箱、订阅或账号 ID',
                            )}
                          />
                        </div>
                        <div className="group-account-picker-filters codex-local-access-custom-routing-filters">
                          <MultiSelectFilterDropdown
                            options={customRoutingTierFilterOptions}
                            selectedValues={customRoutingFilterTypes}
                            allLabel={customRoutingAllTierFilterLabel}
                            filterLabel={t('common.shared.filterLabel', '筛选')}
                            clearLabel={t('accounts.clearFilter', '清空筛选')}
                            emptyLabel={t('common.none', '暂无')}
                            ariaLabel={t('common.shared.filterLabel', '筛选')}
                            onToggleValue={(value) =>
                              setCustomRoutingFilterTypes((prev) =>
                                prev.includes(value)
                                  ? prev.filter((item) => item !== value)
                                  : [...prev, value],
                              )
                            }
                            onClear={() => setCustomRoutingFilterTypes([])}
                          />
                          <AccountTagFilterDropdown
                            availableTags={customRoutingAvailableTags}
                            selectedTags={customRoutingTagFilter}
                            onToggleTag={(value) =>
                              setCustomRoutingTagFilter((prev) =>
                                prev.includes(value)
                                  ? prev.filter((item) => item !== value)
                                  : [...prev, value],
                              )
                            }
                            onClear={() => setCustomRoutingTagFilter([])}
                          />
                        </div>
                        <div className="codex-local-access-custom-routing-bulk">
                          <span className="codex-local-access-custom-routing-selected-count">
                            {t('codex.localAccess.customRoutingSelected', {
                              count: customRoutingSelected.size,
                              defaultValue: '已选 {{count}}',
                            })}
                          </span>
                          <label>
                            <span>{t('codex.localAccess.customRoutingPriorityShort', '优先级')}</span>
                            <input
                              type="number"
                              min={CUSTOM_ROUTING_PRIORITY_MIN}
                              max={CUSTOM_ROUTING_PRIORITY_MAX}
                              value={customRoutingBulkPriority}
                              onChange={(event) => setCustomRoutingBulkPriority(event.target.value)}
                              disabled={saving}
                            />
                          </label>
                          <label>
                            <span>{t('codex.localAccess.customRoutingWeightShort', '权重')}</span>
                            <input
                              type="number"
                              min={CUSTOM_ROUTING_WEIGHT_MIN}
                              max={CUSTOM_ROUTING_WEIGHT_MAX}
                              value={customRoutingBulkWeight}
                              onChange={(event) => setCustomRoutingBulkWeight(event.target.value)}
                              disabled={saving}
                            />
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={applyCustomRoutingBatch}
                            disabled={saving || customRoutingSelected.size === 0}
                          >
                            {t('codex.localAccess.customRoutingApplyBatch', '应用到已选')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={resetCustomRoutingDraft}
                            disabled={saving || customRoutingAccounts.length === 0}
                          >
                            {t('codex.localAccess.customRoutingReset', '重置')}
                          </button>
                        </div>
                      </div>

                      <div className="codex-local-access-custom-routing-list-shell">
                        <div className="codex-local-access-custom-routing-row codex-local-access-custom-routing-row-head">
                  <input
                    ref={customRoutingSelectAllRef}
                    type="checkbox"
                    checked={allVisibleCustomRoutingSelected}
                    onChange={toggleCustomRoutingSelectAllVisible}
                    disabled={saving || visibleCustomRoutingAccounts.length === 0}
                    aria-label={t('common.selectAll', '全选')}
                  />
                          <span>{t('codex.localAccess.customRoutingAccountColumn', '账号')}</span>
                          <span>{t('codex.localAccess.customRoutingQuotaColumn', '额度')}</span>
                          <span>{t('codex.localAccess.customRoutingPriorityShort', '优先级')}</span>
                          <span>{t('codex.localAccess.customRoutingWeightShort', '权重')}</span>
                        </div>

                        <div className="codex-local-access-custom-routing-list">
                          {customRoutingAccounts.length === 0 ? (
                            <div className="group-account-empty">
                              {t(
                                'codex.localAccess.customRoutingEmpty',
                                '当前 API 服务集合没有可配置的账号',
                              )}
                            </div>
                          ) : visibleCustomRoutingAccounts.length === 0 ? (
                            <div className="group-account-empty">
                              {t('common.shared.noMatch.title', '没有匹配的账号')}
                            </div>
                          ) : (
                            visibleCustomRoutingAccounts.map((account) => {
                              const presentation = buildCodexAccountPresentation(account, t);
                              const draftRule = customRoutingDraft[account.id] ?? {
                                priority: CUSTOM_ROUTING_PRIORITY_MIN,
                                weight: CUSTOM_ROUTING_WEIGHT_MIN,
                              };
                              const checked = customRoutingSelected.has(account.id);

                              return (
                                <div
                                  key={account.id}
                                  className={`codex-local-access-custom-routing-row${
                                    checked ? ' is-selected' : ''
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleCustomRoutingSelect(account.id)}
                                    disabled={saving}
                                  />
                                  <div className="codex-local-access-custom-routing-account">
                                    <span
                                      className="group-account-email"
                                      title={maskAccountText(presentation.displayName)}
                                    >
                                      {maskAccountText(presentation.displayName)}
                                    </span>
                                    <span className={`tier-badge ${presentation.planClass}`}>
                                      {presentation.planLabel}
                                    </span>
                                  </div>
                                  <div className="codex-local-access-custom-routing-quota">
                                    {renderQuotaPreview(presentation, 2) ?? (
                                      <span className="codex-local-access-custom-routing-muted">
                                        {t('common.none', '暂无')}
                                      </span>
                                    )}
                                  </div>
                          <label className="codex-local-access-custom-routing-number-field">
                            <span>
                              {t('codex.localAccess.customRoutingPriorityShort', '优先级')}
                            </span>
                            <input
                              className="codex-local-access-custom-routing-number"
                              type="number"
                              min={CUSTOM_ROUTING_PRIORITY_MIN}
                              max={CUSTOM_ROUTING_PRIORITY_MAX}
                              value={draftRule.priority}
                              onChange={(event) =>
                                updateCustomRoutingRule(
                                  account.id,
                                  'priority',
                                  event.target.value,
                                )
                              }
                              disabled={saving}
                              aria-label={t(
                                'codex.localAccess.customRoutingPriorityShort',
                                '优先级',
                              )}
                            />
                          </label>
                          <label className="codex-local-access-custom-routing-number-field">
                            <span>
                              {t('codex.localAccess.customRoutingWeightShort', '权重')}
                            </span>
                            <input
                              className="codex-local-access-custom-routing-number"
                              type="number"
                              min={CUSTOM_ROUTING_WEIGHT_MIN}
                              max={CUSTOM_ROUTING_WEIGHT_MAX}
                              value={draftRule.weight}
                              onChange={(event) =>
                                updateCustomRoutingRule(
                                  account.id,
                                  'weight',
                                  event.target.value,
                                )
                              }
                              disabled={saving}
                              aria-label={t(
                                'codex.localAccess.customRoutingWeightShort',
                                '权重',
                              )}
                            />
                          </label>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="modal-footer codex-local-access-custom-routing-footer">
                      <button
                        className="btn btn-secondary"
                        onClick={closeCustomRoutingDialog}
                        disabled={saving}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => void handleSaveCustomRouting()}
                        disabled={saving || customRoutingAccounts.length === 0}
                      >
                        {saving ? t('common.saving') : t('codex.localAccess.customRoutingSave', '保存自定义调度')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {testDialogOpen && (
                <div
          className="modal-overlay codex-local-access-test-dialog-overlay"
          onClick={closeTestDialog}
        >
          <div
            className="modal codex-local-access-test-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-local-access-test-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header codex-local-access-test-dialog-header">
              <div>
                <h3 id="codex-local-access-test-dialog-title">
                  <ShieldCheck size={18} />
                  <span>{t('codex.localAccess.testDialogTitle', '测试 API 服务')}</span>
                </h3>
                <p>
	                  {isCpaPanelMode
	                    ? t(
	                        'codex.localAccess.testDialogDescCpa',
	                        '直接请求 CPA 服务；管理密码默认 ab2026ab。',
	                      )
	                    : isExternalCredentialPanelMode
	                    ? t(
	                        'codex.localAccess.testDialogDescCustom',
	                        '直接请求自定义 API；如已绑定 OAuth，会先刷新登录态。',
                      )
                    : t(
                        'codex.localAccess.testDialogDesc',
                        '通过 Codex CLI 发起一次真实请求，验证本地服务、密钥和上游响应。',
                      )}
                </p>
              </div>
              <button
                className="modal-close codex-local-access-test-dialog-close"
                onClick={closeTestDialog}
                disabled={testDialogBusy}
                aria-label={t('common.close')}
              >
                <X size={18} />
              </button>
            </div>

            <div className="modal-body codex-local-access-test-dialog-body">
              {testDialogBusy && (
                <div className="codex-local-access-test-progress" aria-live="polite">
                  <RefreshCw size={18} className="loading-spinner" />
                  <div>
                    <strong>{t('codex.localAccess.testProgressTitle', '正在测试服务')}</strong>
                    <span>
	                      {isCpaPanelMode
	                        ? t(
	                            'codex.localAccess.testProgressDescCpa',
	                            '正在向 CPA 服务发起真实请求，请稍候。',
	                          )
	                        : isExternalCredentialPanelMode
	                        ? t(
	                            'codex.localAccess.testProgressDescCustom',
	                            '正在向自定义 API 发起真实请求，请稍候。',
                          )
                        : t(
                            'codex.localAccess.testProgressDesc',
                            '正在向本地 API 服务发起真实请求，请稍候。',
                          )}
                    </span>
                  </div>
                </div>
              )}

              {testSuccessResult && (
                <>
                  {testSuccessResult.output && (
                    <div className="codex-local-access-test-output">
                      <div className="codex-local-access-test-section-title">
                        {t('codex.localAccess.testOutputTitle', '返回结果')}
                      </div>
                      <pre>{testSuccessResult.output}</pre>
                    </div>
                  )}

                  <div className="codex-local-access-test-result">
                    <div className="codex-local-access-test-section-title">
                      {t('codex.localAccess.testResultTitle', '服务检测结果')}
                    </div>
                    <div className="codex-local-access-inline-success">
                      <Check size={14} />
                      <span>
	                        {isCpaPanelMode
	                          ? t('codex.localAccess.testSuccessCpa', {
	                              model: testSuccessResult.modelId ?? '--',
	                              latency: formatLatencyMs(testSuccessResult.latencyMs ?? 0),
	                              defaultValue:
	                                '服务检测成功：CPA 服务和密钥正常（{{model}}，{{latency}}）。',
	                            })
	                          : isExternalCredentialPanelMode
	                          ? t('codex.localAccess.testSuccessCustom', {
                              model: testSuccessResult.modelId ?? '--',
                              latency: formatLatencyMs(testSuccessResult.latencyMs ?? 0),
                              defaultValue:
                                '服务检测成功：自定义 API 和密钥正常（{{model}}，{{latency}}）。如已绑定 OAuth，登录态也可用。',
                            })
                          : t('codex.localAccess.testSuccess', {
                              model: testSuccessResult.modelId ?? '--',
                              latency: formatLatencyMs(testSuccessResult.latencyMs ?? 0),
                              defaultValue:
                                '服务检测成功：本地服务、密钥和上游响应正常（{{model}}，{{latency}}）。如果 Codex 仍报 502，请检查 Codex 的 Base URL、API Key 或运行环境。',
                            })}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {testFailure && (
                <div className="codex-local-access-test-failure" aria-live="assertive">
                  <div className="codex-local-access-test-failure-title">
                    <CircleAlert size={16} />
                    <strong>{testFailure.title}</strong>
                  </div>
                  <dl>
                    <div>
                      <dt>{t('codex.localAccess.testFailureStage', '定位阶段')}</dt>
                      <dd>{testFailure.stage}</dd>
                    </div>
                    <div>
                      <dt>{t('codex.localAccess.testFailureCause', '失败原因')}</dt>
                      <dd>{testFailure.cause}</dd>
                    </div>
                    <div>
                      <dt>{t('codex.localAccess.testFailureSuggestion', '处理建议')}</dt>
                      <dd>{testFailure.suggestion}</dd>
                    </div>
                    {typeof testFailure.status === 'number' && (
                      <div>
                        <dt>{t('codex.localAccess.testFailureStatus', 'HTTP 状态')}</dt>
                        <dd>{testFailure.status}</dd>
                      </div>
                    )}
                    {testFailure.modelId && (
                      <div>
                        <dt>{t('codex.localAccess.testFailureModel', '检测模型')}</dt>
                        <dd>{testFailure.modelId}</dd>
                      </div>
                    )}
                  </dl>
                  {testFailure.detail && (
                    <div className="codex-local-access-test-output">
                      <div className="codex-local-access-test-section-title">
                        {t('codex.localAccess.testFailureDetail', '诊断详情')}
                      </div>
                      <pre>{testFailure.detail}</pre>
                    </div>
                  )}
                  {testFailure.gatewayOutput && (
                    <div className="codex-local-access-test-output">
                      <div className="codex-local-access-test-section-title">
                        {t('codex.localAccess.testFailureGatewayOutput', '网关返回')}
                      </div>
                      <pre>{testFailure.gatewayOutput}</pre>
                    </div>
                  )}
                </div>
              )}

              {testDialogError && (
                <div className="codex-local-access-inline-error" aria-live="assertive">
                  <CircleAlert size={14} />
                  <span>{testDialogError}</span>
                </div>
              )}
            </div>

            <div className="modal-footer codex-local-access-test-dialog-footer">
              <button
                className="btn btn-secondary"
                onClick={closeTestDialog}
                disabled={testDialogBusy}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default CodexLocalAccessModal;
