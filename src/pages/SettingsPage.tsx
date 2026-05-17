import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Download,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  DEFAULT_MODEL_ROLES,
  LLM_PROVIDER_PRESETS,
  ROLE_REQUIRED_CAPABILITIES,
  capabilityLabel,
  getDefaultEndpointForApiMode,
  getProviderModelPreset,
  getProviderModelPresets,
  isKnownProviderEndpoint,
  type LlmApiMode,
  type LlmProviderConfig,
  type LlmProviderId,
  type ModelCapability,
  type ModelRoleId,
} from '@/lib/llm/providers';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  loadProviderSettings,
  resolveProviderConfigForRole,
  saveProviderSettings,
  updateProviderConfig,
  validateActiveProvider,
  type ProviderRoleResolution,
  type LlmProviderSettings,
} from '@/lib/llm/providerSettings';
import {
  createDefaultResearchSettings,
  loadResearchSettings,
  saveResearchSettings,
  type ResearchSettings,
} from '@/lib/research/settings';
import {
  createDefaultMultimodalSettings,
  loadMultimodalSettings,
  saveMultimodalSettings,
  type MultimodalSettings,
} from '@/lib/multimodal/settings';
import {
  checkForUpdates,
  getAppUpdateConfig,
  getUpdateDownloadUrl,
  type UpdateStatus,
} from '@/lib/update/updateCheck';
import { openExternalUrl } from '@/lib/update/openExternalUrl';
import {
  hasAvailableUpdate,
  saveUpdateCheckState,
  useUpdateStore,
} from '@/lib/update/updateStore';

export function SettingsPage() {
  const [settings, setSettings] = useState<LlmProviderSettings>(() => createDefaultProviderSettings());
  const [researchSettings, setResearchSettings] = useState<ResearchSettings>(() => createDefaultResearchSettings());
  const [multimodalSettings, setMultimodalSettings] = useState<MultimodalSettings>(() => createDefaultMultimodalSettings());
  const [expanded, setExpanded] = useState<Set<LlmProviderId>>(new Set(['minimax-cn']));
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setSettings(loadProviderSettings());
    setResearchSettings(loadResearchSettings());
    setMultimodalSettings(loadMultimodalSettings());
  }, []);

  const activeErrors = useMemo(() => validateActiveProvider(settings), [settings]);
  const roleResolutions = useMemo(
    () => new Map(DEFAULT_MODEL_ROLES.map((role) => [role.id, resolveProviderConfigForRole(settings, role.id)])),
    [settings],
  );
  const updateAvailable = useUpdateStore((state) => hasAvailableUpdate(state));

  function persist(next: LlmProviderSettings) {
    setSettings(next);
    saveProviderSettings(next);
    setSavedAt(Date.now());
  }

  function patchProvider(providerId: LlmProviderId, patch: Partial<LlmProviderConfig>) {
    persist(updateProviderConfig(settings, providerId, patch));
  }

  function persistResearch(patch: Partial<ResearchSettings>) {
    const next = { ...researchSettings, ...patch };
    setResearchSettings(next);
    saveResearchSettings(next);
    setSavedAt(Date.now());
  }

  function persistMultimodal(patch: Partial<MultimodalSettings>) {
    const next = { ...multimodalSettings, ...patch };
    setMultimodalSettings(next);
    saveMultimodalSettings(next);
    setSavedAt(Date.now());
  }

  function toggleProvider(providerId: LlmProviderId) {
    const nextActive = settings.activeProviderId === providerId ? null : providerId;
    persist(activateProvider(settings, nextActive));
    setExpanded((current) => new Set(current).add(providerId));
  }

  function toggleExpanded(providerId: LlmProviderId) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">设置</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">设置中心</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#626965]">
            v2 会把模型配置做成可切换的 Provider 中心。当前先保存本地配置和角色分配，后续会接入桌面安全凭据库与真实调用链。
          </p>
        </div>
        <SaveIndicator savedAt={savedAt} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-[12px] border border-[#e5e5e4] bg-white p-3">
          <nav className="grid gap-1">
            <a className="flex items-center gap-2 rounded-[8px] bg-[#f4f8ff] px-3 py-2 text-sm font-medium text-[#155eef]" href="#llm">
              <KeyRound size={16} />
              LLM 模型
            </a>
            <a className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm text-[#626965] hover:bg-[#f7f7f5]" href="#roles">
              <SlidersHorizontal size={16} />
              模型职责
            </a>
            <a className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm text-[#626965] hover:bg-[#f7f7f5]" href="#research">
              <SlidersHorizontal size={16} />
              深度研究
            </a>
            <a className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm text-[#626965] hover:bg-[#f7f7f5]" href="#multimodal">
              <SlidersHorizontal size={16} />
              多模态
            </a>
            <a className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm text-[#626965] hover:bg-[#f7f7f5]" href="#about">
              <Info size={16} />
              <span className="min-w-0 flex-1">关于 / 版本更新</span>
              {updateAvailable ? <span className="size-2 rounded-full bg-[#ef4444]" aria-label="有新版本可用" /> : null}
            </a>
          </nav>
        </aside>

        <main className="grid gap-5">
          <section id="llm" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white">
            <div className="border-b border-[#ececea] px-5 py-4">
              <div className="flex items-center gap-2">
                <Settings2 size={18} className="text-[#155eef]" />
                <h3 className="text-lg font-semibold text-[#1f2937]">LLM 模型</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#626965]">
                每个厂商独立保存配置。打开一个 Provider 后，它会成为当前默认 Wiki 模型，其他 Provider 会自动关闭，但配置不会丢失。
              </p>
            </div>

            <div className="grid gap-3 p-4">
              {LLM_PROVIDER_PRESETS.map((preset) => {
                const config = settings.configs.find((item) => item.providerId === preset.id)!;
                return (
                  <ProviderCard
                    key={preset.id}
                    config={config}
                    isActive={settings.activeProviderId === preset.id}
                    isExpanded={expanded.has(preset.id)}
                    onToggleActive={() => toggleProvider(preset.id)}
                    onToggleExpanded={() => toggleExpanded(preset.id)}
                    onChange={(patch) => patchProvider(preset.id, patch)}
                  />
                );
              })}
            </div>

            {activeErrors.length > 0 ? (
              <div className="mx-4 mb-4 rounded-[10px] border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-sm leading-6 text-[#8a4b00]">
                {activeErrors.map((error) => (
                  <p key={error}>{translateValidation(error)}</p>
                ))}
              </div>
            ) : null}
          </section>

          <section id="roles" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <h3 className="text-lg font-semibold text-[#1f2937]">模型职责</h3>
            <p className="mt-2 text-sm leading-6 text-[#626965]">
              未单独选择时会跟随当前默认 LLM；图片/多模态和 Embedding 会检查模型能力，不支持时会明确提示。
            </p>
            <div className="mt-4 grid gap-3">
              {DEFAULT_MODEL_ROLES.map((role) => {
                const resolution = roleResolutions.get(role.id);
                return (
                  <div key={role.id} className="grid min-w-0 gap-2 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,300px)]">
                    <div className="min-w-0">
                      <span className="block text-sm font-semibold text-[#1f2937]">{role.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#626965]">{role.description}</span>
                    </div>
                    <div className="grid min-w-0 gap-2">
                      <select
                        className={[
                          'h-10 w-full min-w-0 rounded-[8px] border bg-white px-3 text-sm text-[#1f2937]',
                          resolution?.error ? 'border-[#f97316] bg-[#fff7ed]' : 'border-[#d9d9d6]',
                        ].join(' ')}
                        value={settings.roleAssignments[role.id] ?? ''}
                        onChange={(event) =>
                          persist(assignModelRole(settings, role.id as ModelRoleId, event.target.value as LlmProviderId | ''))
                        }
                      >
                        <option value="">跟随当前默认模型</option>
                        {LLM_PROVIDER_PRESETS.map((preset) => {
                          const providerConfig = settings.configs.find((item) => item.providerId === preset.id);
                          return (
                            <option key={preset.id} value={preset.id}>
                              {preset.label}
                              {providerCapabilityNote(providerConfig, role.id)}
                            </option>
                          );
                        })}
                      </select>
                      <p className={['min-w-0 break-words text-xs leading-5', resolution?.error ? 'text-[#b45309]' : 'text-[#626965]'].join(' ')}>
                        {formatRoleResolution(resolution)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section id="research" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <h3 className="text-lg font-semibold text-[#1f2937]">深度研究 / Web Search</h3>
            <p className="mt-2 text-sm leading-6 text-[#626965]">
              用于图谱知识空白和手动补充研究。当前接入 Tavily，研究结果会保存为 Markdown 原始条目并尝试自动摄入 Wiki。
            </p>
            <div className="mt-4 grid gap-4">
              <ConfigField label="搜索 Provider">
                <select
                  className="h-10 w-full min-w-0 rounded-[8px] border border-[#d9d9d6] bg-white px-3 text-sm text-[#1f2937]"
                  value={researchSettings.provider}
                  onChange={(event) => persistResearch({ provider: event.target.value === 'tavily' ? 'tavily' : 'none' })}
                >
                  <option value="none">未启用</option>
                  <option value="tavily">Tavily</option>
                </select>
              </ConfigField>
              <ConfigField label="Tavily API Key">
                <input
                  className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
                  type="password"
                  value={researchSettings.apiKey}
                  onChange={(event) => persistResearch({ apiKey: event.target.value })}
                  placeholder="tvly-..."
                />
              </ConfigField>
              <ConfigField label="每个查询最多返回结果数">
                <input
                  className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
                  type="number"
                  min={1}
                  max={10}
                  value={researchSettings.maxResults}
                  onChange={(event) => persistResearch({ maxResults: Number(event.target.value) })}
                />
              </ConfigField>
            </div>
          </section>

          <section id="multimodal" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <h3 className="text-lg font-semibold text-[#1f2937]">多模态图片内容</h3>
            <p className="mt-2 text-sm leading-6 text-[#626965]">
              图片文件会先走 OCR，再用“图片/多模态模型”生成事实 caption，写入原始条目并进入结构化编译。PDF / DOCX / PPTX 的内嵌图片会按 SHA-256 缓存并追加为 Markdown 图片描述。
            </p>
            <div className="mt-4 grid gap-3">
              <ToggleRow
                title="启用图片 caption"
                detail="打开后，图片进入 Raw Inbox 编译时会调用 vision 模型生成可检索描述。"
                checked={multimodalSettings.enabled}
                onChange={(checked) => persistMultimodal({ enabled: checked })}
              />
              <ToggleRow
                title="独立图片写入视觉描述"
                detail="把 standalone 图片以及文档内嵌图片的视觉描述、OCR 文本和图片引用一起写入 Wiki 编译输入。"
                checked={multimodalSettings.captionStandaloneImages}
                onChange={(checked) => persistMultimodal({ captionStandaloneImages: checked })}
              />
              <ToggleRow
                title="保留 OCR 文本"
                detail="视觉描述之外继续保留 OCR 原文，便于表格、截图和扫描件检索。"
                checked={multimodalSettings.includeOcrText}
                onChange={(checked) => persistMultimodal({ includeOcrText: checked })}
              />
            </div>
          </section>

          <UpdateSettingsSection />
        </main>
      </div>
    </section>
  );
}

function UpdateSettingsSection() {
  const updateStore = useUpdateStore();
  const config = getAppUpdateConfig();
  const available = hasAvailableUpdate(updateStore);
  const result = updateStore.lastResult;
  const sourceLabel = config.repo ? `GitHub Releases：${config.repo}` : '未配置更新源';
  const lastCheckedLabel = updateStore.lastCheckedAt ? formatCheckedAt(updateStore.lastCheckedAt) : '尚未检查';

  async function handleCheckNow() {
    if (useUpdateStore.getState().checking) return;
    useUpdateStore.getState().setChecking(true);
    const nextResult = await checkForUpdates(config);
    const now = Date.now();
    useUpdateStore.getState().setResult(nextResult, now);
    useUpdateStore.getState().setDismissed(null);
    saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: now,
      dismissedVersion: null,
    });
  }

  function handleDismiss() {
    const latest = useUpdateStore.getState().lastResult;
    if (latest?.kind !== 'available') return;
    useUpdateStore.getState().setDismissed(latest.remote);
    saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt ?? Date.now(),
      dismissedVersion: latest.remote,
    });
  }

  function handleToggleAutoCheck() {
    const nextEnabled = !useUpdateStore.getState().enabled;
    useUpdateStore.getState().setEnabled(nextEnabled);
    saveUpdateCheckState({
      enabled: nextEnabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt,
      dismissedVersion: useUpdateStore.getState().dismissedVersion,
    });
  }

  async function handleOpenDownload() {
    const latest = useUpdateStore.getState().lastResult;
    if (latest?.kind !== 'available') return;
    const url = getUpdateDownloadUrl(latest.release, config.releaseUrl);
    try {
      await openExternalUrl(url);
    } catch {
      await copyUpdateUrlOrAlert(url);
    }
  }

  return (
    <section id="about" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Info size={18} className="text-[#155eef]" />
            <h3 className="text-lg font-semibold text-[#1f2937]">关于 / 版本更新</h3>
            {available ? <span className="rounded-full bg-[#ef4444] px-2 py-0.5 text-[11px] font-medium text-white">有新版本</span> : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-[#626965]">
            当前 MVP 使用 GitHub Releases 做轻量版本提示：启动时自动检查，发现新版本后在顶部和设置页提示版本号与下载入口。
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-[8px] border border-[#d9d9d6] bg-white px-3 py-2 text-sm font-medium text-[#1f2937] hover:bg-[#f7f7f5] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void handleCheckNow()}
          disabled={updateStore.checking}
        >
          <RefreshCw size={15} className={updateStore.checking ? 'animate-spin' : ''} />
          {updateStore.checking ? '检查中' : '立即检查'}
        </button>
      </div>

      <div className="mt-4 grid gap-3 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm">
        <InfoRow label="当前版本" value={`v${config.currentVersion.replace(/^v/i, '')}`} mono />
        <InfoRow label="更新源" value={sourceLabel} mono />
        <InfoRow label="上次检查" value={lastCheckedLabel} />
      </div>

      <div className="mt-4">
        <UpdateResultPanel
          result={result}
          configuredReleaseUrl={config.releaseUrl}
          onOpenDownload={() => void handleOpenDownload()}
          onDismiss={handleDismiss}
        />
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm text-[#626965]">
        <input
          type="checkbox"
          className="size-4 rounded border-[#d9d9d6]"
          checked={updateStore.enabled}
          onChange={handleToggleAutoCheck}
        />
        应用启动时自动检查更新（每 1 小时最多一次）
      </label>
    </section>
  );
}

function UpdateResultPanel({
  result,
  configuredReleaseUrl,
  onOpenDownload,
  onDismiss,
}: {
  result: UpdateStatus | null;
  configuredReleaseUrl: string;
  onOpenDownload: () => void;
  onDismiss: () => void;
}) {
  if (!result) {
    return (
      <div className="rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] px-3 py-2 text-sm leading-6 text-[#315078]">
        还没有检查结果。点击“立即检查”可以确认当前是否已有新版本。
      </div>
    );
  }

  if (result.kind === 'available') {
    const preview = formatReleasePreview(result.release.body);
    const downloadUrl = getUpdateDownloadUrl(result.release, configuredReleaseUrl);
    return (
      <div className="rounded-[10px] border border-[#bfdbfe] bg-[#eff6ff] p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#155eef]">
          <Sparkles size={16} />
          发现新版本 {formatVersion(result.remote)}
        </div>
        <p className="mt-1 text-xs text-[#4f678f]">
          当前版本 {formatVersion(result.local)}，下载页：{downloadUrl}
        </p>
        {result.release.name ? <p className="mt-2 text-sm font-medium text-[#1f2937]">{result.release.name}</p> : null}
        {preview ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-white/70 px-3 py-2 text-xs leading-5 text-[#475569]">
            {preview}
          </pre>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#155eef] px-3 py-2 text-sm font-medium text-white hover:bg-[#0f4bd1]"
            onClick={onOpenDownload}
          >
            <Download size={15} />
            打开更新下载页
          </button>
          <button
            type="button"
            className="rounded-[8px] px-3 py-2 text-sm font-medium text-[#4f678f] hover:bg-white/70"
            onClick={onDismiss}
          >
            稍后提醒
          </button>
        </div>
      </div>
    );
  }

  if (result.kind === 'up-to-date') {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-sm text-[#166534]">
        <CheckCircle2 size={16} />
        已是最新版本（远端 {formatVersion(result.remote)}）。
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-sm leading-6 text-[#8a4b00]">
      {result.message}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <span className="text-[#626965]">{label}</span>
      <span className={['min-w-0 break-words text-right text-[#1f2937]', mono ? 'font-mono text-xs' : 'text-sm'].join(' ')}>
        {value}
      </span>
    </div>
  );
}

function formatVersion(version: string) {
  return version.startsWith('v') ? version : `v${version}`;
}

function formatReleasePreview(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return trimmed.length > 520 ? `${trimmed.slice(0, 520)}...` : trimmed;
}

function formatCheckedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function copyUpdateUrlOrAlert(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    window.alert(`无法自动打开浏览器，更新链接已复制：\n${url}`);
  } catch {
    window.alert(`无法自动打开浏览器，请手动访问：\n${url}`);
  }
}

function providerCapabilityNote(config: LlmProviderConfig | undefined, roleId: ModelRoleId) {
  if (!config?.model.trim()) return '';
  const required = ROLE_REQUIRED_CAPABILITIES[roleId];
  const model = getProviderModelPreset(config.providerId, config.model);
  if (!model) {
    return roleId === 'vision' || roleId === 'embedding' ? '（模型能力未确认）' : '';
  }
  const missing = required.filter((capability) => !model.capabilities.includes(capability));
  if (missing.length === 0) return '';
  return `（${missing.map(capabilityLabel).join('、')} 不支持）`;
}

function formatModelCapabilities(config: LlmProviderConfig) {
  const model = getProviderModelPreset(config.providerId, config.model);
  if (!model) return '未收录能力标签';
  return model.capabilities.map(capabilityLabel).join(' / ');
}

function capabilityBadgeClass(capability: ModelCapability) {
  return {
    text: 'border-[#dbe7ff] bg-[#f5f8ff] text-[#315078]',
    vision: 'border-[#d1fae5] bg-[#f0fdf4] text-[#166534]',
    embedding: 'border-[#ede9fe] bg-[#f5f3ff] text-[#5b21b6]',
    ocr: 'border-[#ffedd5] bg-[#fff7ed] text-[#9a3412]',
  }[capability];
}

function modelMatchesRequiredCapability(config: LlmProviderConfig, roleId: ModelRoleId) {
  const model = getProviderModelPreset(config.providerId, config.model);
  if (!model) return roleId !== 'vision' && roleId !== 'embedding';
  return ROLE_REQUIRED_CAPABILITIES[roleId].every((capability) => model.capabilities.includes(capability));
}

function formatModelNotes(config: LlmProviderConfig) {
  const model = getProviderModelPreset(config.providerId, config.model);
  return model?.notes;
}

function modelRoleHint(config: LlmProviderConfig) {
  const supportedRoles = DEFAULT_MODEL_ROLES.filter((role) => modelMatchesRequiredCapability(config, role.id)).map((role) => role.label);
  return supportedRoles.length > 0 ? `可用于：${supportedRoles.join('、')}` : '当前模型能力不匹配任何内置职责。';
}

function modelButtonLabel(config: LlmProviderConfig, modelId: string) {
  const model = getProviderModelPreset(config.providerId, modelId);
  if (!model) return modelId;
  return model.label && model.label !== model.id ? `${model.id} · ${model.label}` : model.id;
}

function modelCapabilityBadges(config: LlmProviderConfig, modelId = config.model) {
  const model = getProviderModelPreset(config.providerId, modelId);
  if (!model) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {model.capabilities.map((capability) => (
        <span
          key={capability}
          className={['rounded-full border px-1.5 py-0.5 text-[10px] leading-none', capabilityBadgeClass(capability)].join(' ')}
        >
          {capabilityLabel(capability)}
        </span>
      ))}
    </span>
  );
}

function currentModelCapabilityBlock(config: LlmProviderConfig) {
  const note = formatModelNotes(config);
  return (
    <div className="rounded-[8px] border border-[#e5e5e4] bg-[#fbfbfa] px-3 py-2 text-xs leading-5 text-[#626965]">
      <div className="flex flex-wrap items-center gap-2">
        <span>当前模型能力：{formatModelCapabilities(config)}</span>
        {modelCapabilityBadges(config)}
      </div>
      <p className="mt-1">{modelRoleHint(config)}</p>
      {note ? <p className="mt-1 text-[#8a4b00]">{note}</p> : null}
    </div>
  );
}

function providerModelOptions(config: LlmProviderConfig) {
  const catalog = getProviderModelPresets(config.providerId);
  const options = catalog.length > 0 ? catalog.map((model) => model.id) : LLM_PROVIDER_PRESETS.find((item) => item.id === config.providerId)?.defaultModels ?? [];
  return options.includes(config.model) || !config.model ? options : [config.model, ...options];
}

function capabilitySummary(modelId: string, config: LlmProviderConfig) {
  const model = getProviderModelPreset(config.providerId, modelId);
  if (!model) return '';
  return model.capabilities.map(capabilityLabel).join(' / ');
}

function capabilitySortedModels(config: LlmProviderConfig) {
  return [...providerModelOptions(config)].sort((left, right) => {
    const leftSummary = capabilitySummary(left, config);
    const rightSummary = capabilitySummary(right, config);
    return leftSummary.localeCompare(rightSummary, 'zh-Hans') || left.localeCompare(right);
  });
}

function modelOptionTitle(config: LlmProviderConfig, modelId: string) {
  const summary = capabilitySummary(modelId, config);
  return summary ? `${modelId}：${summary}` : modelId;
}

function modelOptionClass(config: LlmProviderConfig, modelId: string) {
  const selected = config.model === modelId;
  return [
    'flex min-h-8 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium',
    selected ? 'border-[#155eef] bg-[#155eef] text-white' : 'border-[#d9d9d6] text-[#626965]',
  ].join(' ');
}

function modelOptionCapabilityInline(config: LlmProviderConfig, modelId: string) {
  const model = getProviderModelPreset(config.providerId, modelId);
  if (!model) return null;
  return (
    <span className={config.model === modelId ? 'text-white/80' : 'text-[#8a8f8b]'}>
      {model.capabilities.map(capabilityLabel).join('/')}
    </span>
  );
}

function modelOptionsHint(config: LlmProviderConfig) {
  const catalog = getProviderModelPresets(config.providerId);
  if (catalog.length === 0) return '没有内置模型目录，可手动输入模型 ID。';
  return '模型目录带能力标签；职责页会按当前模型 ID 校验文本、视觉、Embedding、OCR 等能力。';
}

function providerSupportsRoleLabel(config: LlmProviderConfig, roleId: ModelRoleId) {
  const required = ROLE_REQUIRED_CAPABILITIES[roleId];
  const model = getProviderModelPreset(config.providerId, config.model);
  if (!model) return '能力未确认';
  const ok = required.every((capability) => model.capabilities.includes(capability));
  return ok ? '支持' : `缺少 ${required.filter((capability) => !model.capabilities.includes(capability)).map(capabilityLabel).join('、')}`;
}

function roleSupportGrid(config: LlmProviderConfig) {
  return (
    <div className="grid gap-1 rounded-[8px] border border-[#e5e5e4] bg-white px-3 py-2 text-xs text-[#626965] sm:grid-cols-2">
      {DEFAULT_MODEL_ROLES.map((role) => (
        <span key={role.id} className={modelMatchesRequiredCapability(config, role.id) ? 'text-[#166534]' : 'text-[#8a4b00]'}>
          {role.label}：{providerSupportsRoleLabel(config, role.id)}
        </span>
      ))}
    </div>
  );
}

function renderModelOptionButton(config: LlmProviderConfig, modelId: string, onChange: (patch: Partial<LlmProviderConfig>) => void) {
  return (
    <button
      key={modelId}
      type="button"
      title={modelOptionTitle(config, modelId)}
      className={modelOptionClass(config, modelId)}
      onClick={() => onChange({ model: modelId })}
    >
      <span>{modelButtonLabel(config, modelId)}</span>
      {modelOptionCapabilityInline(config, modelId)}
    </button>
  );
}

function renderModelOptions(config: LlmProviderConfig, onChange: (patch: Partial<LlmProviderConfig>) => void) {
  const models = capabilitySortedModels(config);
  if (models.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{models.map((modelId) => renderModelOptionButton(config, modelId, onChange))}</div>;
}

function renderModelCapabilitySection(config: LlmProviderConfig) {
  return (
    <div className="grid gap-2">
      {currentModelCapabilityBlock(config)}
      {roleSupportGrid(config)}
    </div>
  );
}

function renderModelDirectoryHint(config: LlmProviderConfig) {
  return <p className="text-xs leading-5 text-[#626965]">{modelOptionsHint(config)}</p>;
}

function renderModelInput(config: LlmProviderConfig, onChange: (patch: Partial<LlmProviderConfig>) => void, label: string) {
  return (
    <div className="grid gap-2">
      {renderModelOptions(config, onChange)}
      {renderModelDirectoryHint(config)}
      <input
        className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
        aria-label={label}
        value={config.model}
        onChange={(event) => onChange({ model: event.target.value })}
        placeholder="自定义模型名"
      />
      {renderModelCapabilitySection(config)}
    </div>
  );
}

function formatRoleResolution(resolution?: ProviderRoleResolution) {
  if (!resolution) return '等待配置读取。';
  if (resolution.error) return resolution.error;
  if (!resolution.config) return '未配置默认模型。请先开启一个 LLM Provider，或为该职责单独选择模型。';

  const preset = LLM_PROVIDER_PRESETS.find((item) => item.id === resolution.config?.providerId);
  const sourceLabel = resolution.source === 'active' ? '（跟随当前默认）' : '（单独指定）';
  return `实际调用：${preset?.label ?? resolution.config.providerId} / ${resolution.config.model}${sourceLabel}`;
}

function ProviderCard({
  config,
  isActive,
  isExpanded,
  onToggleActive,
  onToggleExpanded,
  onChange,
}: {
  config: LlmProviderConfig;
  isActive: boolean;
  isExpanded: boolean;
  onToggleActive: () => void;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<LlmProviderConfig>) => void;
}) {
  const preset = LLM_PROVIDER_PRESETS.find((item) => item.id === config.providerId)!;
  function switchApiMode(mode: LlmApiMode) {
    const shouldUseModeDefault = !config.endpoint.trim() || isKnownProviderEndpoint(config.providerId, config.endpoint);
    onChange({
      apiMode: mode,
      endpoint: shouldUseModeDefault ? getDefaultEndpointForApiMode(config.providerId, mode) : config.endpoint,
    });
  }

  return (
    <article className={['rounded-[10px] border transition', isActive ? 'border-[#155eef] bg-[#f4f8ff]' : 'border-[#e5e5e4] bg-white'].join(' ')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-full text-[#626965] hover:bg-[#f7f7f5]"
          onClick={onToggleExpanded}
          aria-label={`${isExpanded ? '收起' : '展开'} ${preset.label}`}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggleExpanded}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-[#1f2937]">{preset.label}</span>
            {isActive ? <span className="rounded-full bg-[#111827] px-2 py-0.5 text-[11px] text-white">活跃</span> : null}
            {config.apiKey || config.model !== preset.defaultModels[0] ? (
              <span className="rounded-full border border-[#d9d9d6] px-2 py-0.5 text-[11px] text-[#626965]">已配置</span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-[#626965]">{providerDescription(preset.id)}</p>
        </button>
        <button
          type="button"
          className={['relative h-6 w-11 rounded-full border transition', isActive ? 'border-[#111827] bg-[#111827]' : 'border-[#d9d9d6] bg-[#eeeeed]'].join(' ')}
          onClick={onToggleActive}
          aria-label={`${isActive ? '关闭' : '启用'} ${preset.label}`}
        >
          <span className={['absolute top-0.5 size-5 rounded-full bg-white shadow transition', isActive ? 'left-[18px]' : 'left-0.5'].join(' ')} />
        </button>
      </div>

      {isExpanded ? (
        <div className="grid gap-4 border-t border-[#ececea] px-4 py-4">
          {preset.apiModes.length > 1 ? (
            <div>
              <p className="mb-2 text-sm font-medium text-[#1f2937]">API 模式</p>
              <div className="flex flex-wrap gap-2">
                {preset.apiModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={[
                      'rounded-full border px-3 py-1.5 text-xs font-medium',
                      config.apiMode === mode ? 'border-[#155eef] bg-[#155eef] text-white' : 'border-[#d9d9d6] text-[#626965]',
                    ].join(' ')}
                    onClick={() => switchApiMode(mode)}
                  >
                    {apiModeLabel(mode)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <ConfigField label="接口地址 Endpoint">
              <input
                className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
                aria-label={`${preset.label} 接口地址`}
                value={config.endpoint}
                onChange={(event) => onChange({ endpoint: event.target.value })}
                placeholder={preset.defaultEndpoint || 'https://api.example.com/v1'}
            />
          </ConfigField>

          {preset.requiresApiKey ? (
            <ConfigField label="API Key">
              <input
                className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
                aria-label={`${preset.label} API Key`}
                type="password"
                value={config.apiKey}
                onChange={(event) => onChange({ apiKey: event.target.value })}
                placeholder="填入 API Key"
              />
            </ConfigField>
          ) : (
            <p className="rounded-[8px] border border-[#dbe7ff] bg-[#f5f8ff] px-3 py-2 text-sm text-[#315078]">
              这个 Provider 默认不需要 API Key。
            </p>
          )}

          <ConfigField label="模型名">
            {renderModelInput(config, onChange, `${preset.label} 模型名`)}
          </ConfigField>

          <ConfigField label="上下文窗口">
            <input
              className="h-10 w-full rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
              aria-label={`${preset.label} 上下文窗口`}
              type="number"
              min={4000}
              step={1000}
              value={config.contextWindow}
              onChange={(event) => onChange({ contextWindow: Number(event.target.value) })}
            />
          </ConfigField>
        </div>
      ) : null}
    </article>
  );
}

function ConfigField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 text-sm font-medium text-[#1f2937]">
      <span>{label}</span>
      {children}
    </div>
  );
}

function ToggleRow({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
      <div>
        <p className="text-sm font-semibold text-[#1f2937]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-[#626965]">{detail}</p>
      </div>
      <button
        type="button"
        className={[
          'relative h-6 w-11 shrink-0 rounded-full border transition',
          checked ? 'border-[#111827] bg-[#111827]' : 'border-[#d9d9d6] bg-[#eeeeed]',
        ].join(' ')}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
      >
        <span className={['absolute top-0.5 size-5 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5'].join(' ')} />
      </button>
    </div>
  );
}

function SaveIndicator({ savedAt }: { savedAt: number | null }) {
  if (!savedAt) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-3 py-1.5 text-xs text-[#626965]">
        <Loader2 size={13} />
        等待配置
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#b7e4c7] bg-[#f0fff4] px-3 py-1.5 text-xs text-[#276749]">
      <CheckCircle2 size={13} />
      已保存到本地
    </span>
  );
}

function apiModeLabel(mode: LlmApiMode) {
  return {
    'openai-compatible': 'OpenAI 兼容',
    'anthropic-compatible': 'Anthropic 兼容',
    'gemini-native': 'Gemini 原生',
    'local-cli': '本地 CLI',
  }[mode];
}

function providerDescription(providerId: LlmProviderId) {
  const map: Record<LlmProviderId, string> = {
    openai: 'OpenAI 官方接口，适合 GPT 系列模型。',
    anthropic: 'Anthropic 官方接口，适合 Claude 系列模型。',
    gemini: 'Google Gemini 官方接口，支持长上下文和多模态能力。',
    deepseek: 'DeepSeek OpenAI 兼容接口，适合中文推理和低成本兜底。',
    'minimax-global': 'MiniMax 国际接口，可按 OpenAI 或 Anthropic 兼容模式配置。',
    'minimax-cn': 'MiniMax 中国接口，当前项目可作为主要 Wiki 编译模型。',
    moonshot: 'Kimi / Moonshot OpenAI 兼容接口，适合长文本中文处理。',
    zhipu: '智谱 GLM OpenAI 兼容接口，支持中文和部分视觉模型。',
    groq: 'Groq OpenAI 兼容接口，适合低延迟开源模型调用。',
    xai: 'xAI OpenAI 兼容接口。',
    nvidia: 'NVIDIA NIM 托管推理接口。',
    ollama: '本地 Ollama 接口，不需要 API Key，适合离线或私有模型。',
    'custom-openai': '自定义 OpenAI 兼容接口。',
    'custom-anthropic': '自定义 Anthropic 兼容接口。',
  };
  return map[providerId];
}

function translateValidation(error: string) {
  const map: Record<string, string> = {
    'API Key is required for enabled remote providers.': '已启用的远程 Provider 需要填写 API Key。',
    'Endpoint is required for enabled providers.': '已启用的 Provider 需要填写 Endpoint。',
    'Model is required for enabled providers.': '已启用的 Provider 需要填写模型名。',
    'Context window must be at least 4000 characters.': '上下文窗口至少需要 4000 字符。',
  };
  return map[error] ?? error;
}
