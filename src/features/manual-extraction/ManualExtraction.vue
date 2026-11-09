<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileText,
  LoaderCircle,
  Play,
  RotateCcw,
  ServerOff,
  Sparkles,
  Square,
  Upload,
  XCircle,
} from 'lucide-vue-next';
import {
  buildMarkdown,
  downloadJson,
  downloadText,
  mergeExtractions,
  type ManualDevice,
  type ManualExtraction,
  type ManualLogicRow,
  type ManualSegment,
  type ManualSegmentExtraction,
  type ManualStage,
  type ManualTopologyRow,
  type Sourced,
} from '@/domain/manual';
import { fetchHealth } from '@/services/manual/client';
import { buildSegments } from '@/services/manual/chunk';
import { createRun, runExtraction, type SegmentRun } from '@/services/manual/orchestrator';
import { extractPdfPages, splitPlainText } from '@/services/manual/pdf';
import DevicesTable from './DevicesTable.vue';
import LogicTable from './LogicTable.vue';
import TopologyTable from './TopologyTable.vue';
import './manual-extraction.css';

type Tab = 'devices' | 'topology' | 'logic' | 'raw';

const TABS: { id: Tab; label: string }[] = [
  { id: 'devices', label: '设备' },
  { id: 'topology', label: '业务拓扑' },
  { id: 'logic', label: '控制逻辑' },
  { id: 'raw', label: '原始输出' },
];

const STAGES: ManualStage[] = ['devices', 'topology', 'logic'];

const STAGE_LABEL: Record<ManualStage, string> = {
  devices: '设备抽取',
  topology: '业务拓扑',
  logic: '控制逻辑',
};

interface FileMeta {
  name: string;
  size: number;
  kind: 'pdf' | 'text';
  pageCount: number;
}

const formatNumber = (value: number) => value.toLocaleString('zh-CN');
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const file = shallowRef<File | null>(null);
const fileMeta = ref<FileMeta | null>(null);
const pages = ref<string[]>([]);
const readState = ref<'idle' | 'reading' | 'ready' | 'error'>('idle');
const readError = ref('');
const warnings = ref<string[]>([]);
const options = ref({ pagesPerSegment: 4, maxChars: 12000, headerPct: 8, footerPct: 9 });
const runs = ref<Record<number, SegmentRun>>({});
const running = ref(false);
/** 一轮抽取正常结束（含个别分段失败），与主动停止、致命错误区分开。 */
const runFinished = ref(false);
const fatalError = ref('');
const notice = ref('');
const dragging = ref(false);
const activeSegment = ref<'all' | number>('all');
const tab = ref<Tab>('devices');
const health = ref<{ configured: boolean; model: string } | null>(null);
const healthError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

let abortController: AbortController | null = null;
let healthController: AbortController | null = null;

const segments = computed(() =>
  buildSegments(pages.value, {
    pagesPerSegment: options.value.pagesPerSegment,
    maxChars: options.value.maxChars,
  }),
);

onMounted(() => {
  const controller = new AbortController();
  healthController = controller;
  fetchHealth(controller.signal)
    .then((value) => {
      health.value = value;
      healthError.value = '';
    })
    .catch((error: unknown) => {
      if (isAbort(error)) return;
      health.value = null;
      healthError.value = errorMessage(error);
    });
});

onUnmounted(() => {
  healthController?.abort();
  abortController?.abort();
});

// 分段口径变化后旧结果不再对应，直接清空，避免页码错位。
function updateChunkOptions(patch: Partial<typeof options.value>) {
  Object.assign(options.value, patch);
  runs.value = {};
  activeSegment.value = 'all';
  fatalError.value = '';
  notice.value = '';
  runFinished.value = false;
}

async function loadPdf(source: File) {
  readState.value = 'reading';
  readError.value = '';
  warnings.value = [];
  runs.value = {};
  activeSegment.value = 'all';
  fatalError.value = '';
  notice.value = '';
  try {
    const result = await extractPdfPages(source, {
      headerRatio: options.value.headerPct / 100,
      footerRatio: options.value.footerPct / 100,
    });
    pages.value = result.pages;
    warnings.value = result.warnings;
    fileMeta.value = {
      name: source.name,
      size: source.size,
      kind: 'pdf',
      pageCount: result.pages.length,
    };
    readState.value = 'ready';
  } catch (error) {
    pages.value = [];
    readState.value = 'error';
    readError.value = `PDF 解析失败：${errorMessage(error)}`;
  }
}

async function loadFile(next: File) {
  if (running.value) return;
  const ext = next.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['pdf', 'txt', 'md', 'markdown'].includes(ext)) {
    readState.value = 'error';
    readError.value = '仅支持 PDF、TXT 与 Markdown 文件。';
    return;
  }
  if (next.size > 30 * 1024 * 1024) {
    readState.value = 'error';
    readError.value = '文件超过 30 MB，请先拆分后再上传。';
    return;
  }

  file.value = next;
  fileMeta.value = null;
  pages.value = [];
  runs.value = {};
  activeSegment.value = 'all';
  fatalError.value = '';
  notice.value = '';
  runFinished.value = false;

  if (ext === 'pdf') {
    await loadPdf(next);
    return;
  }

  readState.value = 'reading';
  try {
    const text = await next.text();
    const parts = splitPlainText(text, 1);
    pages.value = parts;
    fileMeta.value = { name: next.name, size: next.size, kind: 'text', pageCount: 1 };
    readState.value = 'ready';
    if (!parts.length) warnings.value = ['文件中没有可抽取的文本。'];
  } catch (error) {
    readState.value = 'error';
    readError.value = `文件读取失败：${errorMessage(error)}`;
  }
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = input.files?.[0];
  if (next) void loadFile(next);
  input.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  const next = event.dataTransfer?.files?.[0];
  if (next) void loadFile(next);
}

function reset() {
  if (running.value) return;
  file.value = null;
  fileMeta.value = null;
  pages.value = [];
  runs.value = {};
  readState.value = 'idle';
  readError.value = '';
  warnings.value = [];
  fatalError.value = '';
  notice.value = '';
  activeSegment.value = 'all';
  tab.value = 'devices';
  runFinished.value = false;
  if (fileInput.value) fileInput.value.value = '';
}

const clamp = (value: number, min: number, max: number, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

function onPagesChange(event: Event) {
  const value = clamp(Number((event.target as HTMLInputElement).value), 1, 20, 1);
  updateChunkOptions({ pagesPerSegment: value });
}

function onMaxCharsChange(event: Event) {
  const value = clamp(Number((event.target as HTMLInputElement).value), 1000, 30000, 12000);
  updateChunkOptions({ maxChars: value });
}

function onHeaderChange(event: Event) {
  options.value.headerPct = clamp(Number((event.target as HTMLInputElement).value), 0, 25, 0);
}

function onFooterChange(event: Event) {
  options.value.footerPct = clamp(Number((event.target as HTMLInputElement).value), 0, 25, 0);
}

async function start(targets: ManualSegment[] = segments.value) {
  if (running.value || !targets.length) return;
  if (!health.value?.configured) {
    fatalError.value = '未配置 DEEPSEEK_API_KEY，暂时无法抽取。';
    return;
  }

  const controller = new AbortController();
  abortController = controller;
  runFinished.value = false;
  running.value = true;
  fatalError.value = '';
  notice.value = '';

  const seeded = { ...runs.value };
  for (const segment of targets) seeded[segment.index] = createRun(segment);
  runs.value = seeded;

  try {
    const result = await runExtraction({
      segments: targets,
      signal: controller.signal,
      onUpdate: (run) => {
        runs.value = { ...runs.value, [run.index]: run };
      },
    });
    const failedCount = result.runs.filter((run) => run.status === 'error').length;
    runFinished.value = true;
    notice.value = failedCount
      ? `抽取结束：${failedCount} 个分段失败，可单独重试；已成功的结果可继续复核。`
      : '抽取完成，可切换分段复核并导出结果。';
  } catch (error) {
    if (isAbort(error)) {
      notice.value = '已停止抽取。未完成的分段可以单独重试。';
      const next: Record<number, SegmentRun> = {};
      for (const [key, run] of Object.entries(runs.value)) {
        next[Number(key)] =
          run.status === 'running' ? { ...run, status: 'error', stage: null, error: '已停止' } : run;
      }
      runs.value = next;
    } else {
      fatalError.value = errorMessage(error);
    }
  } finally {
    running.value = false;
    abortController = null;
  }
}

function stop() {
  abortController?.abort();
}

function clearResults() {
  runs.value = {};
  activeSegment.value = 'all';
  notice.value = '';
}

function reparsePdf() {
  if (file.value) void loadPdf(file.value);
}

const completed = computed(() =>
  segments.value.filter((segment) => runs.value[segment.index]?.status === 'done').length,
);

const failed = computed(() =>
  segments.value.filter((segment) => runs.value[segment.index]?.status === 'error'),
);

const progress = computed(() => {
  if (!segments.value.length) return 0;
  let score = 0;
  for (const segment of segments.value) {
    const run = runs.value[segment.index];
    if (!run) continue;
    if (run.status === 'done') score += 1;
    else if (run.status === 'running') {
      score += run.stage === 'devices' ? 0.12 : run.stage === 'topology' ? 0.45 : 0.78;
    }
  }
  return score / segments.value.length;
});

const extractions = computed<ManualSegmentExtraction[]>(() => {
  const list: ManualSegmentExtraction[] = [];
  for (const segment of segments.value) {
    const run = runs.value[segment.index];
    if (!run) continue;
    if (run.status !== 'done' && !run.devices.length && !run.topology.length && !run.logic.length) {
      continue;
    }
    list.push({
      index: segment.index,
      pageStart: segment.pageStart,
      pageEnd: segment.pageEnd,
      devices: run.devices,
      topology: run.topology,
      logic: run.logic,
      issues: run.issues,
      raw: run.raw,
    });
  }
  return list;
});

const merged = computed(() => mergeExtractions(extractions.value));
const hasData = computed(() =>
  extractions.value.some((item) => item.devices.length || item.topology.length || item.logic.length),
);
const currentRun = computed(() =>
  activeSegment.value === 'all' ? null : runs.value[activeSegment.value] ?? null,
);

const deviceRows = computed<Sourced<ManualDevice>[]>(() =>
  activeSegment.value === 'all'
    ? merged.value.devices
    : (currentRun.value?.devices ?? []).map((row) => ({ row, sources: [activeSegment.value as number] })),
);

const topologyRows = computed<Sourced<ManualTopologyRow>[]>(() =>
  activeSegment.value === 'all'
    ? merged.value.topology
    : (currentRun.value?.topology ?? []).map((row) => ({
        row,
        sources: [activeSegment.value as number],
      })),
);

const logicRows = computed<Sourced<ManualLogicRow>[]>(() =>
  activeSegment.value === 'all'
    ? merged.value.logic
    : (currentRun.value?.logic ?? []).map((row) => ({
        row,
        sources: [activeSegment.value as number],
      })),
);

const modelName = computed(() => {
  for (const segment of segments.value) {
    const run = runs.value[segment.index];
    if (run?.model) return run.model;
  }
  return health.value?.model ?? '';
});

const baseName = computed(() => (fileMeta.value?.name ?? 'manual').replace(/\.[^.]+$/, ''));

function extractionPayload(): ManualExtraction {
  return {
    schemaVersion: 1,
    source: fileMeta.value?.name ?? 'manual',
    exportedAt: new Date().toISOString(),
    model: modelName.value,
    segments: extractions.value,
  };
}

function exportJson() {
  downloadJson(`${baseName.value}-抽取结果.json`, extractionPayload());
}

function exportMarkdown() {
  downloadText(
    `${baseName.value}-抽取结果.md`,
    buildMarkdown(extractionPayload(), merged.value),
  );
}

const scope = computed(() =>
  activeSegment.value === 'all'
    ? {
        devices: merged.value.devices.length,
        topology: merged.value.topology.length,
        logic: merged.value.logic.length,
        sources: extractions.value.length,
      }
    : {
        devices: currentRun.value?.devices.length ?? 0,
        topology: currentRun.value?.topology.length ?? 0,
        logic: currentRun.value?.logic.length ?? 0,
        sources: 1,
      },
);

const activeIssues = computed(() => {
  if (activeSegment.value === 'all') {
    return extractions.value.filter((item) => item.issues.length);
  }
  const run = currentRun.value;
  return run?.issues.length
    ? [{ index: activeSegment.value as number, issues: run.issues }]
    : [];
});

const canStart = computed(
  () =>
    Boolean(health.value?.configured) &&
    !running.value &&
    segments.value.length > 0 &&
    readState.value === 'ready',
);

const startLabel = computed(() =>
  running.value ? '运行中…' : completed.value ? '重新运行全部' : '开始运行',
);

const activeIndex = computed({
  get: () => activeSegment.value,
  set: (value: 'all' | number | string) => {
    activeSegment.value = value === 'all' ? 'all' : Number(value);
  },
});

function segmentStatusText(segment: ManualSegment): string {
  const run = runs.value[segment.index];
  if (!run) return '等待';
  if (run.status === 'running' && run.stage) return `正在${STAGE_LABEL[run.stage]}`;
  if (run.status === 'done') return '完成';
  if (run.status === 'error') return '失败';
  return '等待';
}

function tabCount(id: Tab): number | null {
  if (id === 'devices') return deviceRows.value.length;
  if (id === 'topology') return topologyRows.value.length;
  if (id === 'logic') return logicRows.value.length;
  return null;
}

function rawText(stage: ManualStage): string {
  return currentRun.value?.raw[stage] || '（本阶段没有输出）';
}

function rawLength(stage: ManualStage): number {
  return currentRun.value?.raw[stage]?.length ?? 0;
}
</script>

<template>
  <div class="mp-app mp-embedded">
    <main class="mp-main">
      <div class="mp-embedded-status">
        <span
          class="mp-chip"
          :class="healthError ? 'bad' : health?.configured ? 'ok' : 'warn'"
        >
          <ServerOff v-if="healthError" :size="13" />
          <CheckCircle2 v-else-if="health?.configured" :size="13" />
          <AlertTriangle v-else :size="13" />
          {{
            healthError
              ? '抽取服务不可用'
              : health
                ? health.configured
                  ? `DeepSeek 已配置 · ${health.model}`
                  : '未配置 API Key'
                : '检查服务中…'
          }}
        </span>
        <span class="mp-muted">上传操作手册后，按分段依次抽取设备、业务拓扑与控制逻辑；结果可复核并导出。</span>
      </div>

      <div class="mp-grid">
        <section class="mp-card">
          <div class="mp-card-head">
            <div><Upload :size="16" /><h2>上传手册</h2></div>
            <button v-if="fileMeta" class="mp-text-btn" :disabled="running" @click="reset">更换文件</button>
          </div>

          <input
            id="manual-file-input"
            ref="fileInput"
            class="mp-file-input"
            type="file"
            accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
            @change="onFileChange"
          />
          <div
            class="mp-dropzone-wrap"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <label class="mp-dropzone" :class="{ dragging }" for="manual-file-input">
              <Upload :size="24" />
              <b>拖入文件，或点击选择</b>
              <span>支持 PDF / TXT / Markdown，单个文件不超过 30 MB</span>
            </label>
          </div>

          <div v-if="readState === 'reading'" class="mp-inline-state">
            <LoaderCircle :size="15" class="mp-spin" />正在解析文档…
          </div>

          <div v-if="fileMeta" class="mp-file">
            <span class="mp-file-icon"><FileText :size="16" /></span>
            <div>
              <b>{{ fileMeta.name }}</b>
              <small>
                {{ formatNumber(Math.round(fileMeta.size / 1024)) }} KB ·
                {{ fileMeta.kind === 'pdf' ? `${fileMeta.pageCount} 页` : '纯文本' }}
                {{ pages.length ? ` · ${segments.length} 段` : '' }}
              </small>
            </div>
          </div>

          <div v-if="readState === 'error'" class="mp-hint bad">
            <XCircle :size="14" />{{ readError }}
          </div>
          <div v-for="warning in warnings" :key="warning" class="mp-hint">
            <AlertTriangle :size="14" />{{ warning }}
          </div>

          <div class="mp-options">
            <label>
              <span>每段页数</span>
              <input
                type="number"
                min="1"
                max="20"
                :value="options.pagesPerSegment"
                :disabled="running"
                @change="onPagesChange"
              />
            </label>
            <label>
              <span>每段字符上限</span>
              <input
                type="number"
                min="1000"
                max="30000"
                step="500"
                :value="options.maxChars"
                :disabled="running"
                @change="onMaxCharsChange"
              />
            </label>
            <template v-if="fileMeta?.kind === 'pdf'">
              <label>
                <span>页眉裁剪 %</span>
                <input
                  type="number"
                  min="0"
                  max="25"
                  :value="options.headerPct"
                  :disabled="running"
                  @change="onHeaderChange"
                />
              </label>
              <label>
                <span>页脚裁剪 %</span>
                <input
                  type="number"
                  min="0"
                  max="25"
                  :value="options.footerPct"
                  :disabled="running"
                  @change="onFooterChange"
                />
              </label>
            </template>
          </div>

          <button
            v-if="fileMeta?.kind === 'pdf'"
            class="mp-btn"
            :disabled="running || readState === 'reading'"
            @click="reparsePdf"
          >
            <RotateCcw :size="14" />按当前裁剪重新解析
          </button>

          <p class="mp-footnote">PDF 在浏览器本地解析，文件不会上传到服务器；只有分段文本会发送给模型。</p>
        </section>

        <section class="mp-card">
          <div class="mp-card-head">
            <div><Sparkles :size="16" /><h2>分段抽取</h2></div>
            <span class="mp-muted">{{ segments.length ? `${segments.length} 个分段` : '等待文档' }}</span>
          </div>

          <div v-if="!health?.configured && !healthError" class="mp-hint">
            <AlertTriangle :size="14" />在项目根目录 <code>.env</code> 中写入
            <code>DEEPSEEK_API_KEY=sk-…</code> 后重启开发服务器。
          </div>
          <div v-if="healthError" class="mp-hint bad">
            <ServerOff :size="14" />无法读取抽取服务状态：{{ healthError }}
          </div>

          <div v-if="segments.length === 0" class="mp-placeholder">
            <FileText :size="26" />
            <b>还没有可抽取的分段</b>
            <span>上传手册后，将按页数与字符上限自动切分。</span>
          </div>

          <template v-else>
            <div class="mp-progress">
              <div class="mp-progress-head">
                <span>{{
                  running
                    ? '模型抽取中，请保持页面打开'
                    : completed === segments.length && completed > 0
                      ? '本轮全部完成'
                      : '准备就绪'
                }}</span>
                <b class="mono">{{ completed }} / {{ segments.length }}</b>
              </div>
              <div class="mp-bar"><i :style="{ width: `${Math.round(progress * 100)}%` }" /></div>
            </div>

            <div class="mp-run-actions">
              <button class="mp-btn primary" :disabled="!canStart" @click="start()">
                <LoaderCircle v-if="running" :size="15" class="mp-spin" />
                <Play v-else :size="15" />{{ startLabel }}
              </button>
              <button v-if="running" class="mp-btn danger" @click="stop">
                <Square :size="13" />停止
              </button>
              <button
                v-if="!running && failed.length > 0"
                class="mp-btn"
                @click="start(failed)"
              >
                <RotateCcw :size="14" />重试失败分段（{{ failed.length }}）
              </button>
              <button
                v-if="!running && hasData"
                class="mp-btn ghost"
                @click="clearResults"
              >
                清空结果
              </button>
            </div>

            <div v-if="fatalError" class="mp-hint bad">
              <XCircle :size="14" />{{ fatalError }}
            </div>
            <div v-if="notice" class="mp-inline-state">
              <CheckCircle2 :size="14" />{{ notice }}
            </div>

            <ul class="mp-segments">
              <li
                v-for="segment in segments"
                :key="segment.index"
                class="mp-seg"
                :class="runs[segment.index]?.status ?? 'pending'"
              >
                <span class="mp-seg-index mono">{{ String(segment.index).padStart(2, '0') }}</span>
                <div class="mp-seg-main">
                  <b>
                    分段 {{ segment.index }}
                    <small>第 {{ segment.pageStart }}–{{ segment.pageEnd }} 页 · {{ formatNumber(segment.chars) }} 字</small>
                  </b>
                  <span class="mp-seg-status" :class="runs[segment.index]?.status ?? 'pending'">
                    {{ segmentStatusText(segment) }}
                  </span>
                  <em v-if="runs[segment.index]?.error">{{ runs[segment.index]?.error }}</em>
                </div>
                <div class="mp-seg-counts mono">
                  <template v-if="runs[segment.index]?.status === 'done'">
                    <span>设备 {{ runs[segment.index]?.devices.length }}</span>
                    <span>拓扑 {{ runs[segment.index]?.topology.length }}</span>
                    <span>逻辑 {{ runs[segment.index]?.logic.length }}</span>
                  </template>
                  <span v-else-if="runs[segment.index]?.status === 'running'">
                    {{
                      runs[segment.index]?.elapsedMs
                        ? `${Math.round((runs[segment.index]?.elapsedMs ?? 0) / 1000)} s`
                        : '…'
                    }}
                  </span>
                </div>
              </li>
            </ul>
          </template>
        </section>
      </div>

      <section v-if="Object.keys(runs).length > 0" id="manual-results" class="mp-card mp-results">
        <div class="mp-card-head">
          <div><FileText :size="16" /><h2>抽取结果</h2></div>
          <div class="mp-result-actions">
            <select v-model="activeIndex" aria-label="查看范围">
              <option value="all">全部（合并去重）</option>
              <option v-for="segment in segments" :key="segment.index" :value="segment.index">
                分段 {{ segment.index }} · 第 {{ segment.pageStart }}–{{ segment.pageEnd }} 页{{
                  runs[segment.index]?.status === 'error' ? '（失败）' : ''
                }}
              </option>
            </select>
            <button class="mp-btn" :disabled="!hasData" @click="exportJson">
              <FileJson :size="14" />导出 JSON
            </button>
            <button class="mp-btn" :disabled="!hasData" @click="exportMarkdown">
              <Download :size="14" />导出 Markdown
            </button>
          </div>
        </div>

        <div class="mp-summary">
          <div><span>设备</span><b class="mono">{{ formatNumber(scope.devices) }}</b></div>
          <div><span>业务拓扑</span><b class="mono">{{ formatNumber(scope.topology) }}</b></div>
          <div><span>控制逻辑</span><b class="mono">{{ formatNumber(scope.logic) }}</b></div>
          <div><span>覆盖分段</span><b class="mono">{{ formatNumber(scope.sources) }}</b></div>
        </div>

        <div class="mp-tabs" role="tablist" aria-label="结果分类">
          <button
            v-for="item in TABS"
            :key="item.id"
            role="tab"
            :aria-selected="tab === item.id"
            :class="{ active: tab === item.id }"
            @click="tab = item.id"
          >
            {{ item.label }}<span v-if="tabCount(item.id) !== null">{{ tabCount(item.id) }}</span>
          </button>
        </div>
        <div v-if="modelName" class="mp-model">模型 <code>{{ modelName }}</code></div>

        <DevicesTable v-if="tab === 'devices'" :rows="deviceRows" />
        <TopologyTable v-else-if="tab === 'topology'" :rows="topologyRows" />
        <LogicTable v-else-if="tab === 'logic'" :rows="logicRows" />
        <template v-else>
          <div v-if="activeSegment === 'all'" class="mp-placeholder compact">
            <FileText :size="22" />
            <b>选择具体分段后查看原始输出</b>
            <span>合并视图只展示结构化结果。</span>
          </div>
          <div v-else class="mp-raw">
            <details v-for="stage in STAGES" :key="stage" :open="stage === 'logic'">
              <summary>
                {{ STAGE_LABEL[stage] }}
                <span>{{ rawLength(stage) ? `${formatNumber(rawLength(stage))} 字符` : '无输出' }}</span>
              </summary>
              <pre>{{ rawText(stage) }}</pre>
            </details>
          </div>
        </template>

        <div v-if="tab !== 'raw' && activeIssues.length > 0" class="mp-issues">
          <p v-for="item in activeIssues" :key="item.index">
            <AlertTriangle :size="13" />
            <span>分段 {{ item.index }}：{{ item.issues.join('；') }}</span>
          </p>
        </div>
      </section>
    </main>
  </div>
</template>
