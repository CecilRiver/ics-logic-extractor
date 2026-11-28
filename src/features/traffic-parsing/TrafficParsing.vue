<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  History,
  LoaderCircle,
  Play,
  RotateCcw,
  Upload,
  X,
  XCircle,
} from 'lucide-vue-next';
import {
  summarizeQuality,
  variableQuality,
  type TrafficCategory,
  type TrafficFrame,
  type TrafficJobView,
  type TrafficResult,
  type TrafficRunSummary,
  type TrafficStats,
  type TrafficUnit,
  type TrafficVariable,
} from '@/domain/traffic';
import {
  collectTraffic,
  deleteTrafficRun,
  extractRunVariables,
  fetchTrafficJob,
  listTrafficRuns,
  loadTrafficRun,
  parseTrafficRun,
  trafficDownloadUrl,
} from '@/services/traffic/client';
import {
  exportEvidenceHtml,
  exportExcel,
  exportReportMarkdown,
  exportResultJson,
  exportVariablesCsv,
  exportVariablesMarkdown,
} from '@/services/traffic/export';
import '@/features/manual-extraction/manual-extraction.css';
import '@/styles/history.css';
import '@/styles/quick-nav.css';
import './traffic-parsing.css';

const STAGE_TEXT: Record<string, string> = {
  connect: '连接 PLC',
  upload: '读取控制程序',
  live: '采集运行 / IO 流量',
  pack: '生成流量文件',
  parse: '离线解析',
  done: '完成',
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plcAddresses = ref<string[]>(['']);
const portInput = ref(502);
const timeoutInput = ref(10);
const durationInput = ref(10);
const plcCount = computed(() => plcAddresses.value.filter((address) => address.trim()).length);
const totalDuration = computed(() => {
  const perPlc = Math.min(60, Math.max(1, Math.round(Number(durationInput.value) || 10)));
  return perPlc * Math.max(1, plcCount.value);
});

const job = ref<TrafficJobView | null>(null);
const starting = ref(false);
const errorMessage = ref('');
const variables = ref<TrafficVariable[] | null>(null);
const variablesError = ref('');
const expanded = ref<number[]>([]);

const runs = ref<TrafficRunSummary[]>([]);
const runsLoading = ref(false);
const runsError = ref('');
const deleteTarget = ref('');
const deleting = ref(false);
const historyOpen = ref(false);
const unitSearch = ref('');
const varSearch = ref('');
const varTypeFilter = ref('all');
const varCategoryFilter = ref('all');
const varQualityFilter = ref('all');
const varHasRange = ref(false);
const varPage = ref(1);
const varPageSize = ref(20);

const reversing = ref(false);
const extracting = ref(false);
const reverseError = ref('');
const trafficCategory = ref<'all' | TrafficCategory>('all');
const trafficDirection = ref<'all' | 'request' | 'response'>('all');
const trafficSearch = ref('');
const expandedFrames = ref<number[]>([]);
const pointCategory = ref<'all' | 'runtime' | 'io'>('all');
const pointNonZero = ref(true);
const pointSearch = ref('');
const trafficSection = ref<HTMLElement | null>(null);
const unitsSection = ref<HTMLElement | null>(null);
const topSection = ref<HTMLElement | null>(null);
const trafficCollapsed = ref(false);
const unitsCollapsed = ref(false);
const networkCollapsed = ref(false);
const progressCollapsed = ref(false);

let pollTimer: number | null = null;

const result = computed(() => job.value?.result);
const units = computed<TrafficUnit[]>(() => result.value?.units ?? []);
const isRunning = computed(() => job.value?.status === 'running');
const parsed = computed(() => Boolean(result.value?.parsed) || units.value.length > 0);
const traffic = computed(() => result.value?.traffic ?? null);
const frames = computed(() => (traffic.value?.frames ?? []).filter((frame) => frame.category !== 'upload'));
const trafficStats = computed<TrafficStats>(() => {
  const collection = traffic.value;
  const visible = frames.value;
  const statsFor = (category: 'runtime' | 'io') => {
    const items = visible.filter((frame) => frame.category === category);
    return { frames: items.length, bytes: items.reduce((sum, frame) => sum + frame.bytes, 0) };
  };
  return {
    frames: visible.length,
    bytes: visible.reduce((sum, frame) => sum + frame.bytes, 0),
    upload: collection?.stats?.upload ?? { frames: 0, bytes: 0 },
    runtime: statsFor('runtime'),
    io: statsFor('io'),
    samples: collection?.stats?.samples ?? 0,
    duration_ms: collection?.stats?.duration_ms ?? 0,
    client_ip: collection?.stats?.client_ip ?? '',
    ranges: collection?.stats?.ranges ?? [],
  };
});
const currentRunName = computed(() => result.value?.runDir.split(/[\\/]/).pop() ?? '');
const downloadUrl = computed(() => (currentRunName.value ? trafficDownloadUrl(currentRunName.value) : ''));
const currentPlcs = computed(() => {
  const list = result.value?.plcs?.filter(Boolean) ?? [];
  if (list.length) return list;
  return result.value?.plc ? [result.value.plc] : [];
});

function plcLabel(list?: string[]): string {
  const values = (list ?? []).filter(Boolean);
  if (!values.length) return '—';
  return values.length > 1 ? `${values[0]} 等 ${values.length} 个 PLC` : values[0];
}

function addPlcAddress() {
  if (plcAddresses.value.length >= 10) return;
  plcAddresses.value.push('');
}

function removePlcAddress(index: number) {
  if (index > 0) plcAddresses.value.splice(index, 1);
}
const busy = computed(() => reversing.value || extracting.value);
const canCollect = computed(() => !starting.value && !isRunning.value && !busy.value);
const canReverse = computed(() =>
  Boolean(result.value) && Boolean(currentRunName.value)
  && !busy.value && !isRunning.value && !starting.value,
);
const canExtract = computed(() =>
  parsed.value && Boolean(currentRunName.value)
  && !busy.value && !isRunning.value && !starting.value,
);
const variablesEmpty = computed(() => variables.value !== null && variables.value.length === 0);

const allVariables = computed(() => variables.value ?? []);
const hasVariables = computed(() => allVariables.value.length > 0);
const hasInferred = computed(() => allVariables.value.some((row) => row.inferred));
const decoratedVariables = computed(() =>
  allVariables.value.map((row) => ({ row, quality: variableQuality(row) })),
);
const quality = computed(() => summarizeQuality(allVariables.value));

function baseTypeLabel(value: string): string {
  return (value || '').replace('（推断）', '').trim();
}

function normalizeVariables(rows: TrafficVariable[]): TrafficVariable[] {
  return rows.map((row) => {
    const inferred = Boolean(row.inferred)
      || row.type.includes('（推断）')
      || row.category.includes('（推断）');
    return {
      ...row,
      type: row.type.replace('（推断）', ''),
      category: row.category.replace('（推断）', ''),
      inferred,
    };
  });
}

const filteredUnits = computed(() => {
  const keyword = unitSearch.value.trim().toLowerCase();
  if (!keyword) return units.value;
  return units.value.filter((unit) =>
    [unit.name, unit.plc ?? '', unit.kind, unit.status].join(' ').toLowerCase().includes(keyword),
  );
});

const filteredVariables = computed(() => {
  const keyword = varSearch.value.trim().toLowerCase();
  return decoratedVariables.value.filter(({ row, quality: item }) => {
    if (varTypeFilter.value !== 'all' && baseTypeLabel(row.type) !== varTypeFilter.value) return false;
    if (varCategoryFilter.value !== 'all' && baseTypeLabel(row.category) !== varCategoryFilter.value) return false;
    if (varQualityFilter.value !== 'all' && item.level !== varQualityFilter.value) return false;
    if (varHasRange.value && (!row.range || row.range === '未定')) return false;
    if (!keyword) return true;
    return [row.unit, row.name, row.type, row.category, row.range, row.basis]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const varPageCount = computed(() =>
  Math.max(1, Math.ceil(filteredVariables.value.length / varPageSize.value)),
);

const pagedVariables = computed(() => {
  const page = Math.min(Math.max(1, varPage.value), varPageCount.value);
  const start = (page - 1) * varPageSize.value;
  return filteredVariables.value.slice(start, start + varPageSize.value);
});

watch(
  [varSearch, varTypeFilter, varCategoryFilter, varQualityFilter, varHasRange, varPageSize],
  () => {
    varPage.value = 1;
  },
);

watch(filteredVariables, (list) => {
  const max = Math.max(1, Math.ceil(list.length / varPageSize.value));
  if (varPage.value > max) varPage.value = max;
});

watch(historyOpen, (open) => {
  if (!open) deleteTarget.value = '';
});

function prevVarPage() {
  if (varPage.value > 1) varPage.value -= 1;
}

function nextVarPage() {
  if (varPage.value < varPageCount.value) varPage.value += 1;
}

const trafficTabs: Array<{ id: 'all' | TrafficCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'runtime', label: '运行' },
  { id: 'io', label: 'IO' },
];

function categoryLabel(category: TrafficCategory): string {
  return category === 'upload' ? '上载' : category === 'runtime' ? '运行' : 'IO';
}

const filteredFrames = computed(() => {
  const keyword = trafficSearch.value.trim().toLowerCase();
  return frames.value.filter((frame) => {
    if (trafficCategory.value !== 'all' && frame.category !== trafficCategory.value) return false;
    if (trafficDirection.value !== 'all' && frame.direction !== trafficDirection.value) return false;
    if (!keyword) return true;
    return [
      frame.protocol, frame.function, frame.functionCode, frame.subfunction,
      frame.summary, frame.source, frame.destination, frame.status, frame.session,
      frame.recordIndex, frame.address, frame.tid, frame.time,
      ...(frame.segments ?? []).map((segment) => segment.name),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

function frameSegmentLabel(frame: TrafficFrame): string {
  const names = (frame.segments ?? []).map((segment) => segment.name);
  return names.length ? names.join(' · ') : '—';
}

function frameProperties(frame: TrafficFrame): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    items.push({ label, value: String(value) });
  };
  add('源地址', frame.source);
  add('目的地址', frame.destination);
  add('事务号 TID', frame.tid);
  add('Unit ID', frame.unitId);
  add('MBAP 长度', frame.mbapLength == null ? undefined : `${frame.mbapLength} 字节`);
  add('功能码', frame.functionCode ?? frame.function);
  add('子功能', frame.subfunction);
  add('状态', frame.status);
  add('会话号', frame.session);
  add('记录序号', frame.recordIndex);
  add('起始地址', frame.startAddress);
  add('读取数量', frame.quantity);
  add('字节数', frame.byteCount == null ? undefined : `${frame.byteCount} 字节`);
  if (frame.dataLength !== frame.byteCount) {
    add('数据长度', frame.dataLength == null ? undefined : `${frame.dataLength} 字节`);
  }
  add('总长度', frame.totalBytes == null ? undefined : `${frame.totalBytes} 字节`);
  add('异常码', frame.exception);
  return items;
}

const distribution = computed(() => {
  const stats = trafficStats.value;
  if (!stats) return [];
  const total = stats.bytes || 1;
  return [
    { id: 'runtime' as const, label: '运行', ...stats.runtime, percent: (stats.runtime.bytes / total) * 100 },
    { id: 'io' as const, label: 'IO', ...stats.io, percent: (stats.io.bytes / total) * 100 },
  ];
});
const points = computed(() => traffic.value?.points ?? []);
const nonZeroPointCount = computed(() => points.value.filter((point) => point.value !== 0).length);

const filteredPoints = computed(() => {
  const keyword = pointSearch.value.trim().toLowerCase();
  return points.value.filter((point) => {
    if (pointCategory.value !== 'all' && point.category !== pointCategory.value) return false;
    if (pointNonZero.value && point.value === 0) return false;
    if (!keyword) return true;
    return point.address.toLowerCase().includes(keyword);
  });
});

function toggleFrame(index: number) {
  const at = expandedFrames.value.indexOf(index);
  if (at >= 0) expandedFrames.value.splice(at, 1);
  else expandedFrames.value.push(index);
}

function resetTrafficView() {
  trafficCategory.value = 'all';
  trafficDirection.value = 'all';
  trafficSearch.value = '';
  expandedFrames.value = [];
  pointCategory.value = 'all';
  pointNonZero.value = true;
  pointSearch.value = '';
}

function runLabel(name: string): string {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_?(.*)$/);
  if (!match) return name || '—';
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]} · ${match[7]}`;
}

type SectionTarget = HTMLElement | null | (() => HTMLElement | null);

async function scrollToSection(target: SectionTarget) {
  await nextTick();
  const element = typeof target === 'function' ? target() : target;
  element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function goTop() {
  networkCollapsed.value = false;
  void scrollToSection(() => topSection.value);
}

function toggleNetwork() {
  networkCollapsed.value = !networkCollapsed.value;
}

function toggleProgress() {
  progressCollapsed.value = !progressCollapsed.value;
}

function goTraffic() {
  trafficCollapsed.value = false;
  void scrollToSection(() => trafficSection.value);
}

function goUnits() {
  unitsCollapsed.value = false;
  void scrollToSection(() => unitsSection.value);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function resetFilters() {
  unitSearch.value = '';
  varSearch.value = '';
  varTypeFilter.value = 'all';
  varCategoryFilter.value = 'all';
  varQualityFilter.value = 'all';
  varHasRange.value = false;
  varPage.value = 1;
}

async function refreshRuns() {
  runsLoading.value = true;
  try {
    runs.value = await listTrafficRuns();
    runsError.value = '';
  } catch (error) {
    runsError.value = errorText(error);
  } finally {
    runsLoading.value = false;
  }
}

function clearCurrentRun() {
  stopPolling();
  job.value = null;
  variables.value = null;
  variablesError.value = '';
  reverseError.value = '';
  expanded.value = [];
  expandedFrames.value = [];
  deleteTarget.value = '';
  resetFilters();
  resetTrafficView();
}

async function removeRun(name: string) {
  if (deleting.value || isRunning.value || busy.value) return;
  const wasCurrent = currentRunName.value === name;
  deleting.value = true;
  runsError.value = '';
  try {
    await deleteTrafficRun(name);
    deleteTarget.value = '';
    if (wasCurrent) clearCurrentRun();
    await refreshRuns();
  } catch (error) {
    runsError.value = errorText(error);
  } finally {
    deleting.value = false;
  }
}

async function openRun(name: string) {
  if (isRunning.value || starting.value || busy.value) return;
  stopPolling();
  starting.value = true;
  errorMessage.value = '';
  reverseError.value = '';
  variablesError.value = '';
  try {
    const detail = await loadTrafficRun(name);
    variables.value = detail.variables ? normalizeVariables(detail.variables) : null;
    expanded.value = [];
    resetFilters();
    resetTrafficView();
    job.value = {
      id: `run:${name}`,
      status: 'done',
      stage: 'done',
      percent: 100,
      message: `历史运行：${name}`,
      error: '',
      warnings: [],
      result: detail.result,
      variables: detail.variables ?? undefined,
    };
    trafficCollapsed.value = false;
    unitsCollapsed.value = false;
    networkCollapsed.value = false;
    progressCollapsed.value = false;
    const loaded = detail.result.plcs ?? [];
    const loadedPlcs = loaded.length
      ? [...loaded]
      : (detail.result.plc ? [detail.result.plc] : ['']);
    while (loadedPlcs.length > 1 && !loadedPlcs[loadedPlcs.length - 1]) loadedPlcs.pop();
    plcAddresses.value = loadedPlcs;
    if (detail.result.traffic && !detail.result.parsed) {
      void scrollToSection(() => trafficSection.value);
    } else if (detail.result.parsed) {
      void scrollToSection(() => unitsSection.value);
    }
    historyOpen.value = false;
  } catch (error) {
    errorMessage.value = errorText(error);
  } finally {
    starting.value = false;
  }
}

async function poll(id: string) {
  try {
    const view = await fetchTrafficJob(id);
    // 旧任务的迟到响应不能覆盖新任务。
    if (job.value && job.value.id !== id) return;
    job.value = view;
    if (view.status === 'running') {
      pollTimer = window.setTimeout(() => void poll(id), 600);
    } else {
      pollTimer = null;
      if (view.status === 'done') {
        void refreshRuns();
        if (!view.result?.parsed) void scrollToSection(() => trafficSection.value);
      }
    }
  } catch (error) {
    pollTimer = null;
    errorMessage.value = errorText(error);
  }
}

async function collect() {
  if (!canCollect.value) return;
  const rows = plcAddresses.value.map((address) => address.trim());
  while (rows.length > 1 && !rows[rows.length - 1]) rows.pop();
  const ip = rows[0] ?? '';
  if (!ip) {
    errorMessage.value = '请至少填写 1 个 PLC 的 IP 地址';
    return;
  }
  const addresses = rows;

  stopPolling();
  starting.value = true;
  errorMessage.value = '';
  reverseError.value = '';
  variablesError.value = '';
  variables.value = null;
  expanded.value = [];
  expandedFrames.value = [];
  job.value = null;
  trafficCollapsed.value = false;
  unitsCollapsed.value = false;
  networkCollapsed.value = false;
  progressCollapsed.value = false;
  resetFilters();
  resetTrafficView();

  try {
    const { id } = await collectTraffic({
      ip,
      port: Math.min(65535, Math.max(1, Math.round(Number(portInput.value) || 502))),
      timeout: Math.min(60, Math.max(1, Number(timeoutInput.value) || 10)),
      duration: Math.min(60, Math.max(1, Math.round(Number(durationInput.value) || 10))),
      plcs: addresses,
    });
    job.value = {
      id,
      status: 'running',
      stage: 'connect',
      percent: 0,
      message: '任务已创建，正在连接 PLC',
      error: '',
      warnings: [],
    };
    pollTimer = window.setTimeout(() => void poll(id), 400);
  } catch (error) {
    errorMessage.value = errorText(error);
  } finally {
    starting.value = false;
  }
}

async function reverse() {
  if (!canReverse.value || !result.value || !currentRunName.value) return;
  reversing.value = true;
  reverseError.value = '';
  variablesError.value = '';
  variables.value = null;
  try {
    const parsedResult = await parseTrafficRun(currentRunName.value);
    const parsedFields = parsedResult as unknown as Partial<TrafficResult>;
    const parsedUnits = Array.isArray(parsedFields.units) ? parsedFields.units : [];
    job.value = {
      ...job.value!,
      status: 'done',
      stage: 'done',
      percent: 100,
      message: `源码逆向完成：${parsedUnits.length} 个单元`,
      result: {
        ...result.value,
        ...parsedFields,
        units: parsedUnits,
        parsed: true,
        traffic: result.value.traffic,
      },
    };
    expanded.value = [];
    resetFilters();
    unitsCollapsed.value = false;
    progressCollapsed.value = false;
    void scrollToSection(() => unitsSection.value);
    await refreshRuns();
  } catch (error) {
    reverseError.value = errorText(error);
  } finally {
    reversing.value = false;
  }
}

async function extract() {
  if (!canExtract.value || !result.value || !currentRunName.value) return;
  extracting.value = true;
  variablesError.value = '';
  try {
    variables.value = normalizeVariables(await extractRunVariables(currentRunName.value));
    resetFilters();
    unitsCollapsed.value = false;
    progressCollapsed.value = false;
    if (job.value) {
      job.value = {
        ...job.value,
        message: `变量解析完成：${variables.value.length} 个变量`,
      };
    }
    void scrollToSection(() => unitsSection.value);
    await refreshRuns();
  } catch (error) {
    variablesError.value = `变量解析失败：${errorText(error)}；可点击「解析变量与值域」重试。`;
  } finally {
    extracting.value = false;
  }
}

function exportCsv() {
  if (result.value && variables.value) exportVariablesCsv(result.value, variables.value);
}

function exportVariablesMd() {
  if (result.value && variables.value) exportVariablesMarkdown(result.value, variables.value);
}

function exportReport() {
  if (result.value) exportReportMarkdown(result.value, variables.value);
}

function exportEvidence() {
  if (result.value) exportEvidenceHtml(result.value, variables.value);
}

function exportJson() {
  if (result.value) exportResultJson(result.value, variables.value);
}

function exportXlsx() {
  if (!result.value) return;
  void exportExcel(result.value, variables.value).catch((error) => {
    errorMessage.value = `Excel 导出失败：${errorText(error)}`;
  });
}

function toggleUnit(index: number) {
  const at = expanded.value.indexOf(index);
  if (at >= 0) expanded.value.splice(at, 1);
  else expanded.value.push(index);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

const progressPercent = computed(() => Math.max(0, Math.min(100, job.value?.percent ?? 0)));
const stageText = computed(() => {
  const stage = job.value?.stage ?? '';
  return STAGE_TEXT[stage] ?? stage ?? '等待开始';
});

onMounted(() => {
  void refreshRuns();
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="tp-wrap">
    <div ref="topSection" class="mp-grid tp-top">
      <section class="mp-card">
        <div class="mp-card-head" @click="toggleNetwork">
          <div><Upload :size="16" /><h2>PLC 网络参数</h2></div>
          <div class="mp-card-head-actions">
            <span class="mp-muted">M340 / M251 · TCP 502</span>
            <button class="mp-btn" type="button" @click.stop="toggleNetwork">
              {{ networkCollapsed ? '展开' : '收起' }}
            </button>
          </div>
        </div>

        <div v-show="!networkCollapsed">
        <form class="tp-form" @submit.prevent="collect">
          <div class="tp-plc-list">
            <label v-for="(_, index) in plcAddresses" :key="index" class="tp-field">
              <span>PLC {{ index + 1 }} 地址</span>
              <div class="tp-address-row">
                <input
                  v-model="plcAddresses[index]"
                  type="text"
                  :placeholder="index === 0 ? '192.168.20.55' : '请输入 PLC IP'"
                  autocomplete="off"
                />
                <button
                  v-if="index > 0"
                  class="mp-text-btn"
                  type="button"
                  @click="removePlcAddress(index)"
                >
                  移除
                </button>
              </div>
            </label>
            <button class="mp-btn" type="button" @click="addPlcAddress">+ 添加 PLC 地址</button>
          </div>
          <label class="tp-field">
            <span>端口</span>
            <input v-model.number="portInput" type="number" min="1" max="65535" />
          </label>
          <label class="tp-field">
            <span>超时（秒）</span>
            <input v-model.number="timeoutInput" type="number" min="1" max="60" />
          </label>
          <label class="tp-field">
            <span>单台采集时长（秒）</span>
            <input v-model.number="durationInput" type="number" min="1" max="60" />
            <small v-if="plcCount > 1" class="tp-duration-hint">
              共 {{ plcCount }} 台 PLC，预计采集 {{ totalDuration }} 秒
            </small>
          </label>
        </form>

        <div class="tp-actions">
          <button class="mp-btn primary" type="button" :disabled="!canCollect" @click="collect">
            <LoaderCircle v-if="isRunning || starting" :size="15" class="mp-spin" />
            <Activity v-else :size="15" />{{ isRunning ? '采集中…' : '收集流量' }}
          </button>
        </div>
        <p class="tp-note">
          填写多个 PLC 地址时，将一并采集运行 / IO 流量并解析控制程序。
        </p>
        <p class="tp-note">
          先收集上载、运行与 IO 流量并保存 PCAPNG，再依次点击「逆向源码」和「解析变量与值域」。
        </p>
        </div>
      </section>

      <section class="mp-card">
        <div class="mp-card-head" @click="toggleProgress">
          <div><Activity :size="16" /><h2>采集进度</h2></div>
          <div class="mp-card-head-actions">
            <span
              v-if="job"
              class="mp-chip"
              :class="job.status === 'error' ? 'bad' : isRunning || busy ? 'warn' : 'ok'"
            >
              <XCircle v-if="job.status === 'error'" :size="13" />
              <LoaderCircle v-else-if="isRunning || busy" :size="13" class="mp-spin" />
              <CheckCircle2 v-else :size="13" />
              {{
                job.status === 'error'
                  ? '采集失败'
                  : isRunning
                    ? '采集中'
                    : reversing
                      ? '逆向中'
                      : extracting
                        ? '提取中'
                        : parsed
                          ? (variables ? '解析完成' : '逆向完成')
                          : '采集完成'
              }}
            </span>
            <button class="mp-btn" type="button" @click.stop="toggleProgress">
              {{ progressCollapsed ? '展开' : '收起' }}
            </button>
          </div>
        </div>

        <div v-show="!progressCollapsed">
        <div v-if="!job" class="mp-placeholder compact">
          <FileText :size="22" />
          <b>还没有采集任务</b>
          <span>填写 PLC 地址后点击「收集流量」；也可以从下方运行历史载入已有结果。</span>
        </div>

        <template v-else>
          <div v-if="isRunning" class="mp-progress">
            <div class="mp-progress-head">
              <span>{{ stageText }}</span>
              <b class="mono">{{ Math.round(progressPercent) }}%</b>
            </div>
            <div class="mp-bar"><i :style="{ width: `${progressPercent}%` }" /></div>
          </div>
          <div v-if="job.message" class="tp-progress-message">{{ job.message }}</div>
          <div v-if="reversing" class="tp-progress-message">正在逆向控制程序源码…</div>
          <div v-if="extracting" class="tp-progress-message">正在提取关键变量、值域与物理模型参数…</div>

          <div v-for="warning in job.warnings" :key="warning" class="mp-hint">
            <AlertTriangle :size="14" />{{ warning }}
          </div>
          <div v-if="job.error" class="mp-hint bad">
            <XCircle :size="14" />{{ job.error }}
          </div>
          <div v-if="reverseError" class="mp-hint bad">
            <XCircle :size="14" />逆向失败：{{ reverseError }}
          </div>
        </template>

        <div v-if="errorMessage" class="mp-hint bad">
          <XCircle :size="14" />{{ errorMessage }}
        </div>

        <div v-if="result" class="tp-meta">
          <div><span>工程大小</span><b class="mono">{{ formatBytes(result.imageBytes) }}</b></div>
          <div><span>记录数</span><b class="mono">{{ result.records }}</b></div>
          <div><span>会话号</span><b class="mono">{{ result.session }}</b></div>
          <div><span>程序单元</span><b class="mono">{{ parsed ? units.length : '—' }}</b></div>
          <div class="wide"><span>SHA-256</span><code>{{ result.sha256 }}</code></div>
          <div class="wide"><span>运行目录</span><code class="tp-path">{{ result.runDir }}</code></div>
        </div>
        <div v-if="result" class="tp-current-run">
          <span>当前运行</span>
          <code>{{ runLabel(currentRunName) }}</code>
          <span class="mp-muted">{{ plcLabel(currentPlcs) }} · SHA {{ result.sha256 ? `${result.sha256.slice(0, 12)}…` : '—' }}</span>
        </div>
        <div v-if="result && parsed" class="mp-inline-state">
          <CheckCircle2 :size="14" />已完成控制程序提取：{{ result.records }} 条记录 / {{ formatBytes(result.imageBytes) }}
        </div>
        <div v-else-if="traffic" class="mp-inline-state">
          <CheckCircle2 :size="14" />
          已完成流量采集：{{ trafficStats.frames }} 帧 / {{ formatBytes(trafficStats.bytes) }}，在下方流量区点击「逆向源码」。
        </div>
        </div>
      </section>
    </div>

    <section v-if="traffic" ref="trafficSection" class="mp-card tp-traffic">
      <div class="mp-card-head">
        <div><Activity :size="16" /><h2>运行 / IO 流量</h2></div>
        <div class="tp-traffic-head-actions">
          <span class="tp-current-run">
            当前运行 <code>{{ runLabel(currentRunName) }}</code>
            <span class="mp-muted">{{ plcLabel(currentPlcs) }}</span>
          </span>
          <button
            class="mp-btn primary"
            type="button"
            :disabled="!canReverse"
            title="离线逆向控制程序源码"
            @click="reverse"
          >
            <LoaderCircle v-if="reversing" :size="15" class="mp-spin" />
            <FileText v-else :size="15" />{{ reversing ? '逆向中…' : parsed ? '重新逆向' : '逆向源码' }}
          </button>
          <a v-if="downloadUrl" class="mp-btn" :href="downloadUrl" download>下载 PCAPNG</a>
          <button class="mp-btn" type="button" @click="trafficCollapsed = !trafficCollapsed">
            {{ trafficCollapsed ? '展开' : '收起' }}
          </button>
        </div>
      </div>

      <div v-show="!trafficCollapsed">
      <div class="tp-traffic-stats">
        <div><span>总帧数</span><b class="mono">{{ trafficStats.frames }}</b></div>
        <div><span>总字节</span><b class="mono">{{ formatBytes(trafficStats.bytes) }}</b></div>
        <div><span>运行流量</span><b class="mono">{{ trafficStats.runtime.frames }} 帧</b></div>
        <div><span>IO 流量</span><b class="mono">{{ trafficStats.io.frames }} 帧</b></div>
        <div><span>采样轮次</span><b class="mono">{{ trafficStats.samples }}</b></div>
        <div><span>采集耗时</span><b class="mono">{{ trafficStats.duration_ms }} ms</b></div>
      </div>

      <div class="tp-traffic-bar">
        <span
          v-for="item in distribution"
          :key="item.id"
          :class="item.id"
          :style="{ width: `${item.percent}%` }"
          :title="`${item.label} ${item.frames} 帧`"
        />
      </div>
      <div class="tp-traffic-legend">
        <span v-for="item in distribution" :key="item.id">
          <i :class="item.id" />{{ item.label }} {{ item.frames }} 帧 / {{ formatBytes(item.bytes) }}
        </span>
      </div>

      <div class="tp-traffic-toolbar">
        <div class="tp-tabs" role="tablist" aria-label="流量类别">
          <button
            v-for="item in trafficTabs"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="trafficCategory === item.id"
            :class="{ active: trafficCategory === item.id }"
            @click="trafficCategory = item.id"
          >
            {{ item.label }}
          </button>
        </div>
        <select v-model="trafficDirection" aria-label="方向筛选">
          <option value="all">全部方向</option>
          <option value="request">请求</option>
          <option value="response">响应</option>
        </select>
        <input v-model="trafficSearch" type="text" placeholder="搜索功能 / 摘要 / 协议 / 功能段…" />
        <span class="mp-muted">显示 {{ filteredFrames.length }} / {{ frames.length }} · 点击行查看属性</span>
      </div>

      <div class="mp-table-wrap tp-frame-wrap">
        <table class="mp-table tp-frame-table">
          <thead>
            <tr><th>序号</th><th>时间</th><th>方向</th><th>类别</th><th>协议</th><th>功能</th><th>TID</th><th>功能段</th><th>摘要</th><th>长度</th></tr>
          </thead>
          <tbody>
            <template v-for="frame in filteredFrames" :key="frame.index">
              <tr class="tp-frame-row" title="点击查看核心属性与功能段" @click="toggleFrame(frame.index)">
                <td class="mono">{{ frame.index }}</td>
                <td class="mono">{{ frame.time }}</td>
                <td>{{ frame.direction === 'request' ? '请求' : '响应' }}</td>
                <td><span class="mp-tag" :class="frame.category">{{ categoryLabel(frame.category) }}</span></td>
                <td>{{ frame.protocol }}</td>
                <td class="mono">{{ frame.function }}</td>
                <td class="mono">{{ frame.tid ?? '—' }}</td>
                <td class="tp-seg-label">{{ frameSegmentLabel(frame) }}</td>
                <td class="mp-evidence">{{ frame.summary }}</td>
                <td class="mono">{{ frame.bytes }}</td>
              </tr>
              <tr v-if="expandedFrames.includes(frame.index)">
                <td colspan="10" class="tp-source-cell">
                  <div class="tp-frame-detail">
                    <div class="tp-frame-props">
                      <div v-for="item in frameProperties(frame)" :key="item.label">
                        <span>{{ item.label }}</span><b class="mono">{{ item.value }}</b>
                      </div>
                    </div>
                    <div v-if="frame.segments?.length" class="tp-segments">
                      <div class="tp-segments-title">功能段</div>
                      <div class="mp-table-wrap">
                        <table class="mp-table tp-segment-table">
                          <thead><tr><th>功能段</th><th>偏移</th><th>长度</th><th>字节</th></tr></thead>
                          <tbody>
                            <tr v-for="(segment, segmentIndex) in frame.segments" :key="`${segment.name}-${segmentIndex}`">
                              <td>{{ segment.name }}</td>
                              <td class="mono">{{ segment.offset }}</td>
                              <td class="mono">{{ segment.length }}</td>
                              <td class="mono tp-seg-value">{{ segment.value }}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <pre class="tp-source">{{ frame.hex }}</pre>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!filteredFrames.length">
              <td colspan="10" class="mp-empty">没有符合筛选条件的流量帧</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="tp-points-head">
        <h3>采集点位</h3>
        <span class="mp-muted">{{ points.length }} 个点位 · 非零 {{ nonZeroPointCount }} 个</span>
      </div>
      <div class="tp-traffic-toolbar">
        <select v-model="pointCategory" aria-label="点位类别">
          <option value="all">全部点位</option>
          <option value="runtime">运行点位</option>
          <option value="io">IO 点位</option>
        </select>
        <label class="tp-check"><input v-model="pointNonZero" type="checkbox" />只看非零</label>
        <input v-model="pointSearch" type="text" placeholder="搜索点位地址…" />
        <span class="mp-muted">显示 {{ filteredPoints.length }} / {{ points.length }}</span>
      </div>
      <div v-if="filteredPoints.length" class="mp-table-wrap tp-point-wrap">
        <table class="mp-table tp-point-table">
          <thead>
            <tr><th>类别</th><th>区域</th><th>地址</th><th>值</th></tr>
          </thead>
          <tbody>
            <tr v-for="point in filteredPoints" :key="`${point.category}-${point.address}`">
              <td><span class="mp-tag" :class="point.category">{{ categoryLabel(point.category) }}</span></td>
              <td>{{ point.area }}</td>
              <td class="mono">{{ point.address }}</td>
              <td class="mono">{{ point.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="mp-placeholder compact">
        <FileText :size="22" />
        <b>没有符合筛选条件的点位</b>
        <span>{{ nonZeroPointCount === 0 ? '本次采集点位均为 0，可取消「只看非零」查看全部。' : '调整筛选条件后再看。' }}</span>
      </div>

      <p class="tp-var-note">
        流量文件：<code>{{ traffic.file }}</code>（PCAPNG 另含程序上载会话，用于离线解析）。
        扫描范围：%MW0–1023、%IW0–127、线圈 0–255、离散输入 0–255；地址映射为推测，仅作展示。
        PCAPNG 由采集端请求/响应重建，含合成 TCP 握手与 ACK，便于 Wireshark 查看。
      </p>
      </div>
    </section>

    <section v-if="result && parsed" ref="unitsSection" class="mp-card tp-results">
      <div class="mp-card-head">
        <div><FileText :size="16" /><h2>控制程序</h2></div>
        <div class="tp-unit-head-actions">
          <span class="tp-current-run">
            本次解析 <code>{{ runLabel(currentRunName) }}</code>
            <span class="mp-muted">{{ plcLabel(currentPlcs) }}</span>
          </span>
          <button
            class="mp-btn primary"
            type="button"
            :disabled="!canExtract"
            title="提取关键变量、值域与物理模型参数"
            @click="extract"
          >
            <LoaderCircle v-if="extracting" :size="15" class="mp-spin" />
            <Play v-else :size="15" fill="currentColor" />{{ extracting ? '提取中…' : variables ? '重新解析变量与值域' : '解析变量与值域' }}
          </button>
          <span class="mp-chip ok">
            <CheckCircle2 :size="13" />{{ variables ? '解析完成' : '源码已逆向' }} · {{ units.length }} 个单元
          </span>
          <button class="mp-btn" type="button" @click="unitsCollapsed = !unitsCollapsed">
            {{ unitsCollapsed ? '展开' : '收起' }}
          </button>
        </div>
      </div>

      <div v-show="!unitsCollapsed">
      <div class="tp-export-actions">
        <span class="tp-export-label">导出</span>
        <button class="mp-btn" type="button" @click="exportXlsx"><Download :size="13" />Excel</button>
        <button class="mp-btn" type="button" :disabled="!hasVariables" @click="exportCsv">变量表 CSV</button>
        <button class="mp-btn" type="button" :disabled="!hasVariables" @click="exportVariablesMd">变量表 Markdown</button>
        <button class="mp-btn" type="button" @click="exportReport">分析报告</button>
        <button class="mp-btn" type="button" @click="exportEvidence">验收证据</button>
        <button
          class="mp-btn"
          type="button"
          title="仅导出运行信息、单元摘要与变量表，不含流量帧与源码全文"
          @click="exportJson"
        >结果 JSON</button>
      </div>

      <div class="tp-table-toolbar">
        <input v-model="unitSearch" type="text" placeholder="搜索名称 / PLC / 类型…" />
        <span class="mp-muted">显示 {{ filteredUnits.length }} / {{ units.length }}</span>
      </div>

      <div class="mp-table-wrap">
        <table class="mp-table">
          <thead>
            <tr><th>名称</th><th>PLC</th><th>类型</th><th>字符数</th><th>解析状态</th></tr>
          </thead>
          <tbody>
            <template v-for="unit in filteredUnits" :key="unit.index">
              <tr class="tp-unit-row" @click="toggleUnit(unit.index)">
                <td>
                  <span class="tp-caret">{{ expanded.includes(unit.index) ? '▾' : '▸' }}</span>
                  <b>{{ unit.name }}</b>
                </td>
                <td class="mono">{{ unit.plc || '—' }}</td>
                <td>{{ unit.kind }}</td>
                <td class="mono">{{ unit.chars }}</td>
                <td><span class="mp-tag ok">{{ unit.status }}</span></td>
              </tr>
              <tr v-if="expanded.includes(unit.index)">
                <td colspan="5" class="tp-source-cell">
                  <pre class="tp-source">{{ unit.text }}</pre>
                </td>
              </tr>
            </template>
            <tr v-if="!filteredUnits.length">
              <td colspan="5" class="mp-empty">{{ units.length ? '没有符合筛选条件的单元' : '没有解析出控制程序源码' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="variablesError" class="mp-hint bad">
        <XCircle :size="14" />{{ variablesError }}
      </div>

      <template v-if="variables">
        <div class="mp-progress-head tp-var-head">
          <span>关键变量与值域</span>
          <b class="mono">{{ variables.length }} 个变量</b>
        </div>
        <div v-if="variablesEmpty" class="mp-placeholder compact">
          <FileText :size="22" />
          <b>没有提取到变量</b>
          <span>源码里没有可识别的赋值或比较语句。</span>
        </div>
        <template v-else>
          <div class="tp-var-toolbar">
            <input v-model="varSearch" type="text" placeholder="搜索变量 / 类型 / 依据…" />
            <select v-model="varTypeFilter" aria-label="类型筛选">
              <option value="all">全部类型</option>
              <option value="BOOL">BOOL</option>
              <option value="REAL">REAL</option>
              <option value="INT">INT</option>
              <option value="实例">实例</option>
              <option value="ARRAY[REAL]">ARRAY[REAL]</option>
              <option value="未知">未知</option>
            </select>
            <select v-model="varCategoryFilter" aria-label="类别筛选">
              <option value="all">全部类别</option>
              <option value="输入">输入</option>
              <option value="输出">输出</option>
              <option value="内部">内部</option>
              <option value="模型参数">模型参数</option>
              <option value="未知">未知</option>
            </select>
            <select v-model="varQualityFilter" aria-label="质量筛选">
              <option value="all">全部质量</option>
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
            <select v-model.number="varPageSize" aria-label="每页数量">
              <option :value="20">20 条/页</option>
              <option :value="50">50 条/页</option>
              <option :value="100">100 条/页</option>
            </select>
            <label class="tp-check"><input v-model="varHasRange" type="checkbox" />仅看有值域</label>
            <span class="mp-muted">筛选 {{ filteredVariables.length }} / 共 {{ allVariables.length }}</span>
          </div>

          <div class="tp-quality">
            <span>平均质量 <b class="mono">{{ quality.average }}</b></span>
            <span class="tp-q high">高 {{ quality.high }}</span>
            <span class="tp-q mid">中 {{ quality.mid }}</span>
            <span class="tp-q low">低 {{ quality.low }}</span>
            <span class="mp-muted">有值域 {{ quality.withRange }} / {{ quality.total }}</span>
          </div>

          <div v-if="!filteredVariables.length" class="mp-placeholder compact">
            <FileText :size="22" />
            <b>没有符合筛选条件的变量</b>
            <span>调整搜索或筛选条件后再看。</span>
          </div>
          <template v-else>
            <div class="mp-table-wrap">
              <table class="mp-table tp-var-table">
                <thead>
                  <tr>
                    <th>所属单元</th><th>变量名</th><th>类型</th><th>类别</th>
                    <th>值域范围 / 相关常量</th><th>依据</th><th>质量</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in pagedVariables" :key="`${item.row.unit}-${item.row.name}-${item.row.category}`">
                    <td class="tp-var-unit">{{ item.row.unit }}</td>
                    <td><b>{{ item.row.name }}</b></td>
                    <td>{{ item.row.type || '未知' }}</td>
                    <td><span class="mp-tag type">{{ item.row.category }}</span></td>
                    <td class="tp-var-range">{{ item.row.range }}</td>
                    <td class="mp-evidence">{{ item.row.basis }}</td>
                    <td>
                      <span class="tp-score" :class="item.quality.level">{{ item.quality.score }} · {{ item.quality.level }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="tp-pagination">
              <span class="mp-muted">
                共 {{ filteredVariables.length }} 条 · 第 {{ Math.min(varPage, varPageCount) }} / {{ varPageCount }} 页
              </span>
              <button class="mp-btn" type="button" :disabled="varPage <= 1" @click="prevVarPage">
                上一页
              </button>
              <button class="mp-btn" type="button" :disabled="varPage >= varPageCount" @click="nextVarPage">
                下一页
              </button>
            </div>
          </template>
        </template>
        <p v-if="hasInferred" class="tp-var-note">
          部分变量的类型与类别为按代码用法推断，仅供参考；值域依据见「依据」列。
        </p>
      </template>
      </div>
    </section>

    <aside class="mp-history-drawer" :class="{ open: historyOpen }">
      <div class="mp-history-drawer-head">
        <div class="mp-history-drawer-title">
          <History :size="16" />
          <h2>运行历史</h2>
          <span class="mp-muted">{{ runs.length }} 次</span>
        </div>
        <div class="mp-history-drawer-actions">
          <button class="mp-btn" type="button" :disabled="runsLoading || deleting" @click="refreshRuns">
            <RotateCcw :size="13" />{{ runsLoading ? '刷新中…' : '刷新' }}
          </button>
          <button class="mp-history-drawer-close" type="button" aria-label="收起运行历史" @click="historyOpen = false">
            <X :size="16" />
          </button>
        </div>
      </div>
      <div class="mp-history-drawer-body">
        <div v-if="runsError" class="mp-hint bad">
          <XCircle :size="14" />{{ runsError }}
        </div>
        <div v-else-if="!runs.length" class="mp-placeholder compact">
          <History :size="22" />
          <b>暂无历史运行</b>
          <span>完成一次流量采集或离线解析后，历史记录会出现在这里。</span>
        </div>
        <ul v-else class="mp-run-list">
        <li
          v-for="run in runs"
          :key="run.name"
          :class="{ active: currentRunName === run.name, confirming: deleteTarget === run.name }"
        >
          <div class="mp-run-main">
            <b>{{ run.time || run.name }}</b>
            <small>
              {{ plcLabel(run.plcs && run.plcs.length ? run.plcs : (run.plc ? [run.plc] : [])) }} ·
              {{ run.parsed ? `${run.unitCount} 个单元` : '仅采集' }} ·
              {{ run.frameCount }} 帧 · {{ formatBytes(run.trafficBytes) }}
              {{ run.hasVariables ? ` · ${run.variableCount} 个变量` : '' }}
            </small>
          </div>
          <div class="mp-run-actions">
            <button
              v-if="deleteTarget !== run.name"
              class="mp-btn"
              type="button"
              :disabled="isRunning || starting || busy || deleting"
              @click="openRun(run.name)"
            >
              {{ currentRunName === run.name ? '当前' : '查看' }}
            </button>
            <template v-if="deleteTarget === run.name">
              <button
                class="mp-btn danger"
                type="button"
                :disabled="deleting"
                @click="removeRun(run.name)"
              >
                {{ deleting ? '删除中…' : '确认删除' }}
              </button>
              <button
                class="mp-btn"
                type="button"
                :disabled="deleting"
                @click="deleteTarget = ''"
              >
                取消
              </button>
            </template>
            <button
              v-else
              class="mp-btn danger"
              type="button"
              :disabled="isRunning || starting || busy || deleting"
              @click="deleteTarget = run.name"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
      </div>
    </aside>

    <div v-if="historyOpen" class="mp-history-backdrop" @click="historyOpen = false" />
    <button
      v-if="!historyOpen"
      class="mp-history-toggle"
      type="button"
      aria-label="展开运行历史"
      @click="historyOpen = true"
    >
      <History :size="16" />
      <span>运行历史</span>
      <em v-if="runs.length">{{ runs.length }}</em>
    </button>

    <nav class="mp-quick-nav" aria-label="页面导航">
      <button type="button" title="回到参数" @click="goTop">参数</button>
      <button v-if="traffic" type="button" title="跳转到运行 / IO 流量" @click="goTraffic">流量</button>
      <button v-if="parsed" type="button" title="跳转到控制程序" @click="goUnits">程序</button>
      <button type="button" title="打开运行历史" @click="historyOpen = true">历史</button>
    </nav>
  </div>
</template>
