# Codex 自定义补丁重合并说明

这份文档记录当前 fork 里需要长期保留的 Codex 定制点。以后作者代码更新时，建议先以 `upstream/main` 为基线，再只把这里列出的补丁重新套回去，避免把旧的会话修复、切号弹窗、CPA 服务等历史改动一起带回来。

## 合并原则

1. 先备份当前改动：

```bash
git diff --binary > /Users/dalong/Documents/cockpit-tools-remerge-backup/current-before-remerge.patch
```

2. 同步作者代码后，最终相对作者代码的差异应尽量只保留这些文件：

```text
src-tauri/src/commands/codex.rs
src-tauri/src/lib.rs
src-tauri/src/models/codex.rs
src-tauri/src/modules/codex_account.rs
src/components/codex/CodexPlanBadge.tsx
src/components/codex/CodexPlanBadgeStyleModal.tsx
src/pages/CodexAccountsPage.tsx
src/services/codexService.ts
src/stores/useCodexAccountStore.ts
src/styles/pages/codex.css
src/types/codex.ts
src/utils/codexExportFormats.ts
```

3. 用下面命令确认没有把无关功能带回来：

```bash
git diff --name-status upstream/main
git diff --check upstream/main
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
```

## 1. 徽章样式

目标：Codex 账号卡片、列表、弹窗里的订阅徽章使用可配置样式。

核心文件：

- `src/components/codex/CodexPlanBadge.tsx`
- `src/components/codex/CodexPlanBadgeStyleModal.tsx`
- `src/pages/CodexAccountsPage.tsx`
- `src/styles/pages/codex.css`

关键实现点：

- `CodexPlanBadge.tsx` 提供样式配置、默认偏好和本地存储：
  - `CODEX_PLAN_BADGE_STYLE_STORAGE_KEY`
  - `DEFAULT_CODEX_PLAN_BADGE_STYLE_PREFERENCES`
  - `readCodexPlanBadgeStylePreferences`
  - `writeCodexPlanBadgeStylePreferences`
  - `CodexPlanBadge`
- `CodexAccountsPage.tsx` 中保留：
  - `planBadgeStylePreferences`
  - `showPlanBadgeStyleModal`
  - `handlePlanBadgeStyleChange`
  - `resetPlanBadgeStyles`
  - `renderCodexPlanBadge`
- 把原作者页面里的：

```tsx
<span className={`tier-badge ${displayPlanClass}`}>{displayPlanLabel}</span>
```

替换为：

```tsx
{renderCodexPlanBadge(displayPlanClass, displayPlanLabel)}
```

- 工具栏保留“徽章样式”按钮，底部保留 `CodexPlanBadgeStyleModal`。
- `codex.css` 保留 `.codex-plan-badge-custom`、`.codex-plan-style-*` 相关样式。

## 2. 自定义顺序不丢失

目标：更新版本或重新导入账号后，自定义排序不再因为本地账号 `id` 变化而丢失。

核心文件：

- `src/pages/CodexAccountsPage.tsx`

关键实现点：

- 本地存储升级为：

```ts
const CODEX_CUSTOM_SORT_ORDER_KEY =
  "agtools.codex.accounts.custom_sort_order.v2";
const CODEX_LEGACY_CUSTOM_SORT_ORDER_KEY =
  "agtools.codex.accounts.custom_sort_order.v1";
```

- 保留这些函数：
  - `normalizeCodexCustomSortToken`
  - `normalizeCodexCustomSortTokenPart`
  - `pushCodexCustomSortToken`
  - `buildCodexAccountCustomSortTokens`
  - `getCodexAccountCustomSortKey`
  - `reconcileCodexCustomSortOrder`

稳定 key 优先级：

1. 远端账号 ID + 组织 ID
2. 用户 ID + 组织 ID
3. API Key 账号的 provider/baseUrl/email
4. email
5. 本地 `id` 兜底

排序比较和自定义排序弹窗都要使用 `getCodexAccountCustomSortKey(account)`，不要再直接用 `account.id` 作为持久化 key。

## 3. 绑定手机号

目标：Codex 账号支持绑定手机号，卡片完整显示手机号，并提供手机号筛选。

核心文件：

- `src-tauri/src/models/codex.rs`
- `src-tauri/src/modules/codex_account.rs`
- `src-tauri/src/commands/codex.rs`
- `src-tauri/src/lib.rs`
- `src/types/codex.ts`
- `src/services/codexService.ts`
- `src/stores/useCodexAccountStore.ts`
- `src/pages/CodexAccountsPage.tsx`
- `src/styles/pages/codex.css`

后端字段：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub bound_phone: Option<String>,
```

后端更新函数：

```rust
pub fn update_account_phone(account_id: &str, phone: String) -> Result<CodexAccount, String>
```

Tauri command：

```rust
#[tauri::command]
pub async fn update_codex_account_phone(
    account_id: String,
    phone: String,
) -> Result<CodexAccount, String>
```

前端 service/store：

```ts
updateCodexAccountPhone(accountId, phone)
updateAccountPhone(accountId, phone)
```

页面关键点：

- `phoneSearchQuery` 用于手机号筛选。
- `normalizeCodexPhoneSearchText` 会去掉空格、横线、括号、点和加号，方便模糊匹配。
- `renderAccountPhoneButton` 显示完整号码，不做脱敏。
- 绑定手机号弹窗保留 `editingAccountPhoneId`、`editingAccountPhoneValue`、`handleSubmitAccountPhone`。
- `codex.css` 保留：
  - `.codex-phone-filter-box`
  - `.codex-account-phone-chip`
  - `.codex-account-phone-input`

## 4. 导入导出手机号和标签

目标：导出 JSON 时带上手机号和标签，后续导入时能恢复。

核心文件：

- `src/utils/codexExportFormats.ts`
- `src-tauri/src/modules/codex_account.rs`

导出字段：

```json
{
  "bound_phone": "手机号",
  "phone": "手机号",
  "account_note": "备注",
  "tags": ["标签1", "标签2"]
}
```

`codexExportFormats.ts` 中保留：

- `CodexPortableTokenStorage extends JsonRecord`
- `resolveBoundPhone`
- `appendAccountMetadata`

导出时需要在这些路径调用 `appendAccountMetadata`：

- `buildSub2apiCredentials`
- `toPortableTokenStorage`
- `toPortableApiKeyStorage`

导入时 `codex_account.rs` 需要支持这些字段名：

```text
bound_phone
boundPhone
phone
phone_number
phoneNumber
mobile
tags
account_note
accountNote
note
notes
remark
```

注意：sub2api 导出会把 metadata 放在 `credentials` 里，所以导入端必须同时读取顶层和 `credentials`：

- `extract_account_note_from_value`
- `extract_bound_phone_from_value`
- `extract_tags_from_value`

这些 metadata 要贯穿直接导入、批量预览、批量确认三条路径：

- `CodexJsonImportCandidate`
- `CodexBatchImportDraft`
- `preview_account_from_full_tokens`
- `preview_account_from_access_token`
- `confirm_codex_batch_import`

## 5. 删除或隐藏中转站入口

目标：保留作者主体代码时，不让“中转站/API relay”入口出现在导航、平台布局弹窗和页面路由里。

如果只是“不显示入口”，优先做轻量隐藏，避免大面积删除作者代码。

轻量隐藏点：

- `src/components/layout/SideNav.tsx`
  - 不插入 `API_RELAY_LAYOUT_ENTRY_ID`
  - `apiRelayEntryVisible` 固定为 `false`，或直接删除 `result.splice(... api-relay ...)`
- `src/components/PlatformLayoutModal.tsx`
  - `apiRelayEntryEnabled` 固定为 `false`
  - 不把 `type: 'api-relay'` 插入 `entries`
- `src/App.tsx`
  - 如果用户进入 `page === 'api-relay'`，直接跳回默认页面

彻底删除时再处理这些文件：

```text
src/types/navigation.ts
src/components/layout/SideNav.tsx
src/components/PlatformLayoutModal.tsx
src/App.tsx
src/pages/ApiKeyFunPage.tsx
src/pages/ApiKeyFunPage.css
src/utils/apikeyFunLinks.ts
src/utils/apiKeyFunPrefill.ts
src/assets/icons/apikey-fun.png
src/locales/*.json
```

彻底删除风险更高，因为作者后续可能继续改 `ApiKeyFunPage`、赞助模块、远端平台可见性和平台布局设置。下次同步时如果只想“不显示”，建议只用轻量隐藏。

## 6. 每次重合并后的验证

```bash
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check upstream/main
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
```

如果要打 mac 包：

```bash
npx tauri build --bundles app,dmg --no-sign --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'
```
