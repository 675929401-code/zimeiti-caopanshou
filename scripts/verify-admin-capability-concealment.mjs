import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

const page = read("src/app/admin/page.tsx");
const selfRoute = read("src/app/api/admin/access-control/self/route.ts");
const authority = read("src/lib/server/admin-governance-authority.ts");
const agentsRoute = read("src/app/api/admin/agents/route.ts");
const workspaceTab = read("src/components/admin/WorkspaceModelsAdminTab.tsx");
const modelsRoute = read("src/app/api/admin/models/route.ts");
const workspaceModelsRoute = read("src/app/api/admin/workspace-models/route.ts");
const credentialHealthRoute = read("src/app/api/admin/credential-health/route.ts");
const modelHealthRoute = read("src/app/api/admin/model-health/route.ts");
const channelHealthRoute = read("src/app/api/video/channel-health/route.ts");
const governance = read("src/lib/admin-governance.ts");
const proxy = read("src/proxy.ts");
const whiteLabelPanel = read("src/components/admin/WhiteLabelReadinessPanel.tsx");
const unifiedModelsTab = read("src/components/unified-models-tab.tsx");
const modelsAdminTab = read("src/components/admin/models-admin-tab.tsx");
const readOnlyModelsTab = read("src/components/admin/unified-models-read-only-admin-tab.tsx");
const paymentTab = read("src/components/admin/payment-config-admin-tab.tsx");
const layoutTab = read("src/components/admin/LayoutTab.tsx");
const shortcutsManager = read("src/components/admin/ShortcutIconsManager.tsx");
const navigationVerifier = read("scripts/verify-admin-navigation-desktop-readonly.mjs");
const unlockControl = read("src/components/admin/admin-sensitive-unlock-control.tsx");

const publicColumns = agentsRoute.match(/const AGENT_PUBLIC_COLUMNS = \[([\s\S]*?)\] as const;/u)?.[1] || "";
const sensitiveAgentFields = [
  "bot_id",
  "model",
  "coze_coding_api_url",
  "coze_coding_api_token",
  "coze_coding_project_id",
  "proxy_url",
  "model_id",
  "enable_knowledge_base",
  "knowledge_base_id",
  "credential_source_agent_id",
  "system_prompt",
];
for (const field of sensitiveAgentFields) {
  assert.ok(!publicColumns.includes(`'${field}'`), `AGENTS_PUBLIC_DTO_EXPOSES_${field.toUpperCase()}`);
}
assert.ok(!agentsRoute.includes(".select('*')"), "AGENTS_ROUTE_SELECT_STAR_FORBIDDEN");
assert.match(agentsRoute, /Array\.from\(new Set\(selectedColumns\)\)\.join\(','\)/u, "AGENTS_GET_ALLOWLIST_SELECT_MISSING");
assert.match(agentsRoute, /includeConfiguration[\s\S]*?'agents\.manage'[\s\S]*?'models\.manage'/u, "AGENT_CONFIGURATION_READ_PERMISSIONS_MISSING");
assert.match(agentsRoute, /includePrompt[\s\S]*?'prompts\.view'[\s\S]*?requireStepUp: true/u, "AGENT_PROMPT_READ_STEP_UP_MISSING");
assert.match(agentsRoute, /AGENT_PROMPT_INPUT_KEYS[\s\S]*?'system_prompt'[\s\S]*?'systemPrompt'/u, "AGENT_PROMPT_ALIASES_MISSING");
assert.match(agentsRoute, /hasOwnInput\(body, AGENT_PROMPT_INPUT_KEYS\)[\s\S]*?'prompts\.edit'[\s\S]*?requireStepUp: true/u, "AGENT_PROMPT_WRITE_PERMISSION_MISSING");
assert.match(agentsRoute, /hasOwnInput\(body, AGENT_CONFIGURATION_INPUT_KEYS\)[\s\S]*?'models\.manage'[\s\S]*?requireStepUp: true/u, "AGENT_CONFIGURATION_WRITE_PERMISSION_MISSING");
assert.equal((agentsRoute.match(/authorizeAgentFieldChanges\(request, body as Record<string, unknown>\)/gu) || []).length, 2, "AGENT_POST_AND_PUT_FIELD_GATES_REQUIRED");
assert.match(agentsRoute, /\.\.\.\(includeConfiguration \? \{ dataSource: configurationSourceStatus\(\) \} : \{\}\)/u, "AGENT_DATA_SOURCE_MUST_BE_PROTECTED");
for (const mojibake of ["鏃犵", "绠＄", "鍒涘", "鏇存", "鏅鸿", "鈹€", "澶辨", "缂撳瓨"]) {
  assert.ok(!agentsRoute.includes(mojibake), `AGENT_ROUTE_MOJIBAKE_${mojibake}`);
}

assert.match(selfRoute, /const grantedCatalog = ADMIN_PERMISSION_CATALOG\.filter/u, "SELF_GRANTED_CATALOG_FILTER_MISSING");
assert.match(selfRoute, /catalog: isSuperAdmin \? ADMIN_PERMISSION_CATALOG : grantedCatalog/u, "SELF_CATALOG_PROJECTION_MISSING");
assert.match(selfRoute, /Object\.entries\(completeTabAccess\)\.filter\(\(\[, allowed\]\) => allowed === true\)/u, "SELF_ALLOWED_TABS_ONLY_MISSING");
assert.match(selfRoute, /tab === "super-admin"[\s\S]*?\? isSuperAdmin/u, "SUPER_ADMIN_TAB_LEVEL_GATE_MISSING");
assert.match(selfRoute, /tab === "aiweb-import"[\s\S]*?permissionKeys\.includes\("prompts\.edit"\)/u, "IMPORT_PROMPT_PERMISSION_MISSING");
assert.doesNotMatch(selfRoute, /checksum:\s*access\.checksum/u, "SELF_CHECKSUM_EXPOSURE_FORBIDDEN");

assert.match(authority, /access\.adminLevel === "super_admin" \? \{ requiredPermission: permissionKey \} : \{\}/u, "DENIAL_DETAILS_LEVEL_GATE_MISSING");
assert.equal((authority.match(/requiredPermission/gu) || []).length, 1, "REQUIRED_PERMISSION_MUST_ONLY_EXIST_IN_PRIVILEGED_HELPER");
assert.match(authority, /appendAdminGovernanceAudit\(\{[\s\S]*?permissionKey,[\s\S]*?result: "denied"/u, "DENIAL_AUDIT_PERMISSION_KEY_MISSING");

assert.match(page, /\.filter\(\(tab, index, tabs\) => tabs\.indexOf\(tab\) === index && canExposeAdminTab\(adminAccess, tab\)\)/u, "VISIBLE_ADMIN_TAB_FILTER_MISSING");
assert.match(page, /window\.history\.replaceState\(null, "", `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`\)/u, "UNAUTHORIZED_URL_REPLACE_MISSING");
assert.match(page, /token && adminAccess && hasGrantedStepUpCapability &&/u, "GLOBAL_UNLOCK_CAPABILITY_GATE_MISSING");
assert.doesNotMatch(page, /admin-tab-locked|尚缺权限|activeTabMissingPermissions|activeTabPermissionDefinitions|· 锁定/u, "UNAUTHORIZED_FEATURE_DISCLOSURE_COPY_PRESENT");
assert.match(page, /allowedTabs = module\.tabs\.filter\(\(tabKey\) => visibleAdminTabSet\.has\(tabKey\)\)/u, "PRIMARY_NAV_CONCEALMENT_MISSING");
assert.match(page, /const allowedTabs = activeModule\?\.tabs\.filter\(\(tabKey\) => visibleAdminTabSet\.has\(tabKey\)\)/u, "SECONDARY_NAV_CONCEALMENT_MISSING");
assert.match(page, /hasMemberPermissionsManagePermission && <button[^\n]+openUserAccessEditor/u, "ADMIN_ACCOUNT_ENTRY_PERMISSION_GATE_MISSING");
assert.match(page, /canEditPrompts && <PromptVersionHistory/u, "PROMPT_HISTORY_EDIT_GATE_MISSING");
assert.match(page, /editingAgent\.source !== "llm" && canReadPrompts/u, "NON_LLM_PROMPT_READ_GATE_MISSING");
assert.match(page, /if \(!canEditPrompts\) delete agentData\.systemPrompt/u, "CREATE_PROMPT_OMISSION_MISSING");
assert.match(page, /if \(!canEditPrompts\) delete \(rest as Partial<AgentInfo>\)\.system_prompt/u, "UPDATE_PROMPT_OMISSION_MISSING");

assert.match(page, /grantedPermissionKeys\.has\("agents\.manage"\) && grantedPermissionKeys\.has\("prompts\.view"\)/u, "WORKSPACE_COMMERCE_MANJU_PERMISSION_PAIR_MISSING");
assert.match(page, /visibleProjectIds=\{visibleWorkspaceProjectIds\}/u, "WORKSPACE_VISIBLE_PROJECTS_NOT_PASSED");
assert.match(page, /target === "plugins"[\s\S]*?integrations\.manage/u, "WORKSPACE_PLUGIN_GATE_MISSING");
assert.match(page, /target === "manju-workbench"[\s\S]*?canReadPrompts \?/u, "WORKSPACE_MANJU_PROMPT_GATE_MISSING");
assert.match(page, /grantedPermissionKeys\.has\("models\.manage"\)\) projects\.push\("voice"\)/u, "WORKSPACE_VOICE_ENTRY_PERMISSION_GATE_MISSING");
assert.match(page, /target === "voice-studio"[\s\S]*?grantedPermissionKeys\.has\("models\.manage"\)[\s\S]*?sensitiveUnlocked/u, "VOICE_STUDIO_PERMISSION_GATE_MISSING");
assert.match(page, /<ModelsAdminTab[\s\S]*?canManageModelsPermission=\{hasModelSettingsPermission\}[\s\S]*?sensitiveUnlocked=\{sensitiveUnlocked\}/u, "MODEL_SELF_PERMISSION_PROP_GATE_MISSING");
assert.match(modelsAdminTab, /const canManageModels = canManageModelsPermission && sensitiveUnlocked/u, "MODEL_WRITE_PROP_GATE_MISSING");
assert.match(modelsAdminTab, /canManageModelsPermission \? \([\s\S]*?<UnifiedModelsTab[\s\S]*?: \([\s\S]*?<UnifiedModelsReadOnlyAdminTab/u, "MODEL_MANAGEMENT_CHUNK_SELECTION_GATE_MISSING");
assert.match(page, /if \(canManageAgentConfiguration\) \{\s*void loadLlmModels\(\);\s*void loadDrawingModels\(\);\s*\}/u, "AGENT_MODEL_CATALOG_PREFETCH_GATE_MISSING");
assert.doesNotMatch(page, /if \(permissions\.has\("models\.view"\)\) \{\s*void loadLlmModels\(\);\s*void loadDrawingModels\(\);\s*\}/u, "MODEL_READ_MUST_NOT_PREFETCH_MEMBER_CATALOGS");
assert.match(unifiedModelsTab, /fetch\("\/api\/admin\/models", \{ headers: authHeaders \}\)/u, "MODEL_READ_MUST_USE_SANITIZED_ADMIN_DTO");
assert.match(unifiedModelsTab, /canManageModels \? fetch\("\/api\/video\/channel-health"/u, "MODEL_HEALTH_PREFETCH_MANAGE_GATE_MISSING");
assert.match(unifiedModelsTab, /canManageModels \? fetch\("\/api\/admin\/credential-health"/u, "MODEL_CREDENTIAL_PREFETCH_MANAGE_GATE_MISSING");
assert.match(page, /canManagePlugins=\{hasIntegrationSettingsPermission\}/u, "MODEL_PLUGIN_SELF_PERMISSION_PROP_MISSING");
assert.match(modelsAdminTab, /canManagePlugins=\{canManagePlugins && sensitiveUnlocked\}/u, "MODEL_PLUGIN_PROP_GATE_MISSING");
assert.match(page, /canManagePaymentSettings=\{hasPaymentSettingsPermission\}/u, "MODEL_PAYMENT_SELF_PERMISSION_PROP_MISSING");
assert.match(modelsAdminTab, /canManagePaymentSettings=\{canManagePaymentSettings && sensitiveUnlocked\}/u, "MODEL_PAYMENT_PROP_GATE_MISSING");
assert.match(readOnlyModelsTab, /fetch\("\/api\/admin\/models"/u, "MODEL_READ_ONLY_CHUNK_SOURCE_MISSING");
assert.match(page, /<WorkspaceModelsAdminTab[\s\S]*?canManage=\{grantedPermissionKeys\.has\("models\.manage"\) && sensitiveUnlocked\}/u, "WORKSPACE_MODEL_WRITE_PROP_GATE_MISSING");
assert.match(governance, /payment-config\|payment-methods[\s\S]*?permission: "payment\.settings\.manage", requireStepUp: true/u, "PAYMENT_STEP_UP_API_GATE_MUST_REMAIN_STRICT");
assert.match(governance, /pathname\.startsWith\("\/api\/admin\/shortcuts"\)[\s\S]*?permission: "brand\.settings\.manage", requireStepUp: true/u, "SHORTCUT_STEP_UP_API_GATE_MUST_REMAIN_STRICT");
assert.match(paymentTab, /const loadMethods = async \(\) => \{\s*if \(!token \|\| !sensitiveUnlocked\)[\s\S]*?fetch\("\/api\/admin\/payment-methods"/u, "PAYMENT_METHOD_READ_STEP_UP_PREFETCH_GATE_MISSING");
assert.match(paymentTab, /useEffect\(\(\) => \{\s*void loadMethods\(\);[\s\S]*?\}, \[sensitiveUnlocked, token\]\);/u, "PAYMENT_METHOD_UNLOCK_REFRESH_MISSING");
assert.match(paymentTab, /data-testid="payment-methods-step-up-required"[\s\S]*?验证密码后读取/u, "PAYMENT_METHOD_LOCKED_STATE_MISSING");
assert.match(paymentTab, /\{sensitiveUnlocked && showMethodForm && \(/u, "PAYMENT_METHOD_WRITE_FORM_LOCK_GATE_MISSING");
assert.match(page, /activeTab === "layout" && hasBrandSettingsPermission[\s\S]*?sensitiveUnlocked \? \([\s\S]*?<LayoutTab[\s\S]*?: \([\s\S]*?data-testid="layout-step-up-required"/u, "LAYOUT_STEP_UP_RENDER_GATE_MISSING");
assert.match(page, /data-testid="layout-step-up-required"[\s\S]*?setUnlockDialogRequested\(true\)[\s\S]*?验证密码后读取/u, "LAYOUT_UNLOCK_ACTION_MISSING");
assert.match(layoutTab, /<ShortcutIconsManager \/>/u, "LAYOUT_SHORTCUT_MANAGER_MISSING");
assert.match(shortcutsManager, /const loadShortcuts = useCallback\(async \(\) => \{[\s\S]*?fetch\("\/api\/admin\/shortcuts"[\s\S]*?useEffect\(\(\) => \{ loadShortcuts\(\); \}, \[loadShortcuts\]\);/u, "SHORTCUT_UNLOCKED_MOUNT_GET_MISSING");
assert.match(navigationVerifier, /lockedSensitiveReadPaths = new Set\(\[[\s\S]*?"\/api\/admin\/payment-methods"[\s\S]*?"\/api\/admin\/shortcuts"/u, "LOCKED_SENSITIVE_ZERO_REQUEST_TARGETS_MISSING");
assert.match(navigationVerifier, /lockedSensitiveReadPaths = new Set\(\[[\s\S]*?"\/api\/settings\/admin"/u, "LOCKED_PLATFORM_SETTINGS_READ_TARGET_MISSING");
assert.match(navigationVerifier, /if \(report\.lockedSensitiveReadAttempts\.length\) addIssue\("LOCKED_SENSITIVE_READ_ATTEMPTED"/u, "LOCKED_SENSITIVE_ZERO_REQUEST_CONTRACT_MISSING");
assert.match(navigationVerifier, /if \(report\.lockedSensitive428Responses\.length\) addIssue\("LOCKED_SENSITIVE_428_RESPONSE"/u, "LOCKED_SENSITIVE_ZERO_428_RESPONSE_CONTRACT_MISSING");
assert.match(navigationVerifier, /if \(report\.lockedSensitiveConsole428\.length\) addIssue\("LOCKED_SENSITIVE_CONSOLE_428"/u, "LOCKED_SENSITIVE_ZERO_CONSOLE_428_CONTRACT_MISSING");
const loadSettingsSource = page.slice(page.indexOf("const loadSettings = useCallback"), page.indexOf("const loadOpPasswordStatus"));
assert.ok(loadSettingsSource.includes('fetch("/api/settings/appearance"'), "PLATFORM_APPEARANCE_PUBLIC_READ_MISSING");
assert.ok(loadSettingsSource.includes("if (!sensitiveUnlocked || !sensitiveUnlockedRef.current || readableSettingScopes.length === 0) return;"), "PLATFORM_SETTINGS_REALTIME_STEP_UP_GATE_MISSING");
assert.ok(loadSettingsSource.indexOf('fetch("/api/settings/appearance"') < loadSettingsSource.indexOf("if (!sensitiveUnlocked || !sensitiveUnlockedRef.current"), "PLATFORM_APPEARANCE_MUST_LOAD_BEFORE_STEP_UP_GATE");
assert.ok(loadSettingsSource.indexOf("if (!sensitiveUnlocked || !sensitiveUnlockedRef.current") < loadSettingsSource.indexOf("/api/settings/admin?scope="), "PLATFORM_INTERNAL_SETTINGS_MUST_REMAIN_BEHIND_STEP_UP_GATE");
assert.doesNotMatch(page, /adminAccess\?\.stepUp\.status !== "ready"/u, "PLATFORM_SETTINGS_STALE_STEP_UP_GATE_FORBIDDEN");
assert.match(page, /if \(!sensitiveUnlockedRef\.current\) return;\s*const scopedSettings/u, "PLATFORM_SETTINGS_INFLIGHT_RELOCK_GUARD_MISSING");
assert.match(page, /if \(sensitiveUnlocked\) return;[\s\S]*?setSettings\(createDefaultPlatformSettings\(\)\);[\s\S]*?setCozeTestResult\(null\);[\s\S]*?\}, \[sensitiveUnlocked\]\);/u, "PLATFORM_SETTINGS_LOCK_SNAPSHOT_CLEAR_MISSING");
assert.match(page, /grantedPermissionKeys\.has\("brand\.settings\.manage"\) \|\| \(readableSettingScopes\.length && sensitiveUnlocked\)[\s\S]*?void loadSettings\(\);/u, "PLATFORM_APPEARANCE_LOCKED_PUBLIC_READ_EFFECT_MISSING");
assert.match(page, /const visibleSettings = useMemo\(\(\) => sensitiveUnlocked \? settings : \{[\s\S]*?pushedPlatformTheme[\s\S]*?pushedPlatformThemeMode/u, "PLATFORM_SETTINGS_LOCKED_DOM_MASK_MISSING");
assert.match(page, /value=\{visibleSettings\.global_system_prefix\}/u, "PROMPT_SETTINGS_LOCKED_DOM_MASK_MISSING");
assert.ok((page.match(/settings=\{visibleSettings\}/gu) || []).length >= 2, "INTEGRATION_AND_MODEL_SETTINGS_LOCKED_DOM_MASK_MISSING");
assert.match(unlockControl, /window\.setTimeout\(update, Math\.max\(0, expiryTime - Date\.now\(\)\) \+ 1\)/u, "STEP_UP_EXACT_EXPIRY_TIMER_MISSING");
assert.match(navigationVerifier, /benignNavigationAbortPaths = new Set\(\["\/", "\/login", "\/help", "\/admin"\]\)/u, "BENIGN_NAVIGATION_ABORT_ALLOWLIST_MISSING");
assert.match(navigationVerifier, /entry\.sameOrigin !== true[\s\S]*?entry\.method !== "GET"[\s\S]*?entry\.error !== "net::ERR_ABORTED"/u, "BENIGN_NAVIGATION_ABORT_BASE_CLASSIFIER_MISSING");
assert.match(navigationVerifier, /entry\.resourceType === "fetch"[\s\S]*?benignNavigationAbortPaths\.has\(pathname\)/u, "BENIGN_FETCH_NAVIGATION_ABORT_ALLOWLIST_MISSING");
assert.match(navigationVerifier, /entry\.resourceType === "image"[\s\S]*?branding\\\/assets[\s\S]*?test\(pathname\)/u, "BENIGN_BRANDING_IMAGE_ABORT_EXACT_CLASSIFIER_MISSING");
assert.match(navigationVerifier, /report\.benignNavigationAborts = report\.networkErrors\.filter\(isBenignNavigationAbort\)/u, "BENIGN_NAVIGATION_ABORT_REPORT_MISSING");
assert.match(navigationVerifier, /!entry\.blockedByPolicy && !isBenignNavigationAbort\(entry\)/u, "UNEXPECTED_NETWORK_ERRORS_MUST_EXCLUDE_ONLY_CLASSIFIED_NAVIGATION_ABORTS");
assert.match(workspaceTab, /visibleProjectIds\?: readonly WorkspaceProjectId\[\]/u, "WORKSPACE_VISIBLE_PROJECT_PROP_MISSING");
assert.match(workspaceTab, /return NAV_ITEMS\.filter\(\(item\) => allowedProjects\.has\(item\.id\)\)/u, "WORKSPACE_NAV_FILTER_MISSING");
assert.match(workspaceTab, /visibleNavItems\.find\(\(item\) => item\.id === navItem\) \|\| visibleNavItems\[0\] \|\| null/u, "WORKSPACE_SELECTED_PROJECT_FALLBACK_MISSING");
assert.match(workspaceTab, /const groupItems = visibleNavItems\.filter/u, "WORKSPACE_GROUP_FILTER_MISSING");

assert.match(modelsRoute, /function readOnlyModel\(model: UnifiedModel\)/u, "MODEL_READ_ONLY_DTO_MISSING");
assert.match(modelsRoute, /models: canManageModels \? currentModels : currentModels\.map\(readOnlyModel\)/u, "MODEL_SERVER_PROJECTION_MISSING");
assert.match(modelsRoute, /readAdminStepUpSnapshot\(req, authorization\.actor\.userId, "models\.manage"\)/u, "MODEL_SENSITIVE_READ_STEP_UP_MISSING");
for (const forbiddenField of ["api_endpoint", "api_key_configured", "cost_price", "provider", "protocol_type", "admin_notes", "api_protocol_config", "proxy_url"]) {
  const projection = modelsRoute.match(/function readOnlyModel\(model: UnifiedModel\) \{([\s\S]*?)\n\}/u)?.[1] || "";
  assert.ok(!projection.includes(forbiddenField), `MODEL_READ_ONLY_DTO_EXPOSES_${forbiddenField.toUpperCase()}`);
}
assert.match(workspaceModelsRoute, /\.filter\(\(model\) => model\.visibleNow\)/u, "WORKSPACE_READ_ONLY_PUBLIC_MODELS_ONLY_MISSING");
assert.match(workspaceModelsRoute, /provider:\s*""[\s\S]*?costLabels:\s*\[\]/u, "WORKSPACE_READ_ONLY_INTERNAL_FIELDS_NOT_REMOVED");
assert.match(workspaceModelsRoute, /authorizeWorkspaceWrite\(request\)/u, "WORKSPACE_WRITE_ROUTE_GATE_MISSING");
for (const [source, label] of [[credentialHealthRoute, "CREDENTIAL"], [modelHealthRoute, "MODEL_HEALTH"], [channelHealthRoute, "CHANNEL_HEALTH"]]) {
  assert.match(source, /authorizeAdminCapability\(request, "models\.manage", \{[\s\S]*?requireStepUp: true/u, `${label}_MANAGE_STEP_UP_MISSING`);
}
assert.match(governance, /pathname\.startsWith\("\/api\/video\/channel-health"\)[\s\S]*?permission: "models\.manage"[\s\S]*?requireStepUp: true/u, "CHANNEL_HEALTH_PROXY_GATE_MISSING");
assert.match(proxy, /const adminRequirement = adminRequirementForRequest\([\s\S]*?const requiredFeature = !adminRequirement && pathname\.startsWith\("\/api\/"\)/u, "ADMIN_CONTROL_PLANE_MUST_PRECEDE_MEMBER_FEATURE_GATE");
assert.equal((proxy.match(/const adminRequirement = adminRequirementForRequest/gu) || []).length, 1, "ADMIN_REQUIREMENT_MUST_BE_RESOLVED_ONCE");
assert.match(governance, /chat-models\|video-models\|cover-models\|workspace-model-releases\|model-pool-releases\|model-health\|credential-health[\s\S]*?permission: "models\.manage"[\s\S]*?requireStepUp: true/u, "RAW_MODEL_CONTROL_PLANE_GATE_MISSING");
assert.match(governance, /"white-label": "white_label\.manage"/u, "WHITE_LABEL_TAB_PERMISSION_MISSING");
assert.match(page, /activeTab === "white-label"[\s\S]*?grantedPermissionKeys\.has\("white_label\.manage"\)[\s\S]*?<WhiteLabelReadinessPanel/u, "WHITE_LABEL_ENTRY_GATE_MISSING");
assert.match(whiteLabelPanel, /fetch\("\/api\/admin\/domain-release\/status"/u, "WHITE_LABEL_DOMAIN_STATUS_SOURCE_MISSING");
assert.match(whiteLabelPanel, /fetch\("\/api\/admin\/multitenant-boundary"/u, "WHITE_LABEL_TENANT_BOUNDARY_SOURCE_MISSING");
assert.match(whiteLabelPanel, /当前没有证据的环节会明确显示/u, "WHITE_LABEL_TRUTHFULNESS_COPY_MISSING");

console.log("admin capability concealment contract: ok");
