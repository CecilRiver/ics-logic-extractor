<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
  XCircle,
} from 'lucide-vue-next';
import {
  summarizeQuality,
  variableQuality,
  type TrafficJobView,
  type TrafficRunSummary,
  type TrafficVariable,
} from '@/domain/traffic';
import {
  extractRunVariables,
  extractTrafficVariables,
  fetchTrafficJob,
  listTrafficRuns,
  loadTrafficRun,
  startTrafficJob,
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
import './traffic-parsing.css';

const STAGE_TEXT: Record<string, string> = {
  connect: '连接 PLC',
  upload: '提取控制程序',
  reverse: '解析控制程序',
  done: '解析完成',
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ipInput = ref('');
const portInput = ref(502);
const timeoutInput = ref(10);

const job = ref<TrafficJobView | null>(null);
const starting = ref(false);
const errorMessage = ref('');
const variables = ref<TrafficVariable[] | null>(null);
const variablesRunning = ref(false);
const variablesError = ref('');
const expanded = ref<number[]>([]);

const runs = ref<TrafficRunSummary[]>([]);
const runsLoading = ref(false);
const runsError = ref('');
const viewingRun = ref('');
const unitSearch = ref('');
const varSearch = ref('');
const varTypeFilter = ref('all');
const varCategoryFilter = ref('all');
const varQualityFilter = ref('all');
const varHasRange = ref(false);

let pollTimer: number | null = null;

const result = computed(() => job.value?.result);
const units = computed(() => result.value?.units ?? []);
const isRunning = computed(() => job.value?.status === 'running');
const canStart = computed(() => !starting.value && !isRunning.value);
const finished = computed(() => job.value?.status === 'done');
const variablesEmpty = computed(() => variables.value !== null && variables.value.length === 0);
const variablesBusy = computed(() => variablesRunning.value || Boolean(job.value?.variablesRunning));

const allVariables = computed(() => variables.value ?? []);
const hasVariables = computed(() => allVariables.value.length > 0);
const decoratedVariables = computed(() =>
  allVariables.value.map((row) => ({ row, quality: variableQuality(row) })),
);
const quality = computed(() => summarizeQuality(allVariables.value));
const currentRunName = computed(() => result.value?.runDir.split(/[\\/]/).pop() ?? '');
const isHistorical = computed(() => Boolean(job.value?.id.startsWith('run:')));

function baseTypeLabel(value: string): string {
  return (value || '').replace('（推断）', '').trim();
}

const filteredUnits = computed(() => {
  const keyword = unitSearch.value.trim().toLowerCase();
  if (!keyword) return units.value;
  return units.value.filter((unit) =>
    [unit.name, unit.kind, unit.status].join(' ').toLowerCase().includes(keyword),
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

async function openRun(name: string) {
  if (isRunning.value || starting.value) return;
  stopPolling();
  starting.value = true;
  errorMessage.value = '';
  variablesError.value = '';
  try {
    const detail = await loadTrafficRun(name);
    viewingRun.value = name;
    variables.value = detail.variables;
    expanded.value = [];
    resetFilters();
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
      if (view.status === 'done') void refreshRuns();
    }
  } catch (error) {
    pollTimer = null;
    errorMessage.value = errorText(error);
  }
}

async function start() {
  if (!canStart.value) return;
  const ip = ipInput.value.trim();
  if (!ip) {
    errorMessage.value = '请填写被测 PLC 的 IP 地址';
    return;
  }

  stopPolling();
  starting.value = true;
  errorMessage.value = '';
  variablesError.value = '';
  variables.value = null;
  expanded.value = [];
  job.value = null;
  viewingRun.value = '';
  resetFilters();

  try {
    const { id } = await startTrafficJob({
      ip,
      port: Math.min(65535, Math.max(1, Math.round(Number(portInput.value) || 502))),
      timeout: Math.min(60, Math.max(1, Number(timeoutInput.value) || 10)),
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

async function runVariables() {
  if (!job.value || job.value.status !== 'done' || variablesBusy.value) return;
  variablesRunning.value = true;
  variablesError.value = '';
  try {
    variables.value = viewingRun.value
      ? await extractRunVariables(viewingRun.value)
      : await extractTrafficVariables(job.value.id);
    resetFilters();
    void refreshRuns();
  } catch (error) {
    variablesError.value = errorText(error);
  } finally {
    variablesRunning.value = false;
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
    <div class="mp-grid tp-top">
      <section class="mp-card">
        <div class="mp-card-head">
          <div><Upload :size="16" /><h2>PLC 网络参数</h2></div>
          <span class="mp-muted">M340 · TCP 502</span>
        </div>

        <form class="tp-form" @submit.prevent="start">
          <label class="tp-field">
            <span>PLC 地址</span>
            <input v-model="ipInput" type="text" placeholder="192.168.20.55" autocomplete="off" />
          </label>
          <label class="tp-field">
            <span>端口</span>
            <input v-model.number="portInput" type="number" min="1" max="65535" />
          </label>
          <label class="tp-field">
            <span>超时（秒）</span>
            <input v-model.number="timeoutInput" type="number" min="1" max="60" />
          </label>
        </form>

        <div class="tp-actions">
          <button class="mp-btn primary" type="button" :disabled="!canStart" @click="start">
            <LoaderCircle v-if="isRunning || starting" :size="15" class="mp-spin" />
            <Play v-else :size="15" />开始解析
          </button>
        </div>
      </section>

      <section class="mp-card">
        <div class="mp-card-head">
          <div><Activity :size="16" /><h2>{{ isHistorical ? '历史结果' : '解析进度' }}</h2></div>
          <span
            v-if="job"
            class="mp-chip"
            :class="job.status === 'done' ? 'ok' : job.status === 'error' ? 'bad' : 'warn'"
          >
            <CheckCircle2 v-if="job.status === 'done'" :size="13" />
            <XCircle v-else-if="job.status === 'error'" :size="13" />
            <LoaderCircle v-else :size="13" class="mp-spin" />
            {{ job.status === 'done' ? '解析成功' : job.status === 'error' ? '解析失败' : '解析中' }}
          </span>
        </div>

        <div v-if="!job" class="mp-placeholder compact">
          <FileText :size="22" />
          <b>还没有解析任务</b>
          <span>填写 PLC 地址后点击「开始解析」，自动完成控制程序提取；也可以从下方运行历史载入已有结果。</span>
        </div>

        <template v-else>
          <div v-if="!isHistorical" class="mp-progress">
            <div class="mp-progress-head">
              <span>{{ stageText }}</span>
              <b class="mono">{{ Math.round(progressPercent) }}%</b>
            </div>
            <div class="mp-bar"><i :style="{ width: `${progressPercent}%` }" /></div>
          </div>
          <div v-if="job.message" class="tp-progress-message">{{ job.message }}</div>

          <div v-for="warning in job.warnings" :key="warning" class="mp-hint">
            <AlertTriangle :size="14" />{{ warning }}
          </div>
          <div v-if="job.error" class="mp-hint bad">
            <XCircle :size="14" />{{ job.error }}
          </div>
        </template>

        <div v-if="errorMessage" class="mp-hint bad">
          <XCircle :size="14" />{{ errorMessage }}
        </div>

        <div v-if="result" class="tp-meta">
          <div><span>工程大小</span><b class="mono">{{ formatBytes(result.imageBytes) }}</b></div>
          <div><span>记录数</span><b class="mono">{{ result.records }}</b></div>
          <div><span>会话号</span><b class="mono">{{ result.session }}</b></div>
          <div><span>程序单元</span><b class="mono">{{ result.units.length }}</b></div>
          <div class="wide"><span>SHA-256</span><code>{{ result.sha256 }}</code></div>
          <div class="wide"><span>运行目录</span><code class="tp-path">{{ result.runDir }}</code></div>
        </div>
        <div v-if="result" class="mp-inline-state">
          <CheckCircle2 :size="14" />已完成控制程序提取：{{ result.records }} 条记录 / {{ formatBytes(result.imageBytes) }}
        </div>
      </section>
    </div>

    <section class="mp-card mp-history">
      <div class="mp-card-head">
        <div><History :size="16" /><h2>运行历史</h2></div>
        <div class="mp-history-actions">
          <span class="mp-muted">{{ runs.length }} 次运行</span>
          <button class="mp-btn" type="button" :disabled="runsLoading" @click="refreshRuns">
            <RotateCcw :size="13" />{{ runsLoading ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </div>
      <div v-if="runsError" class="mp-hint bad">
        <XCircle :size="14" />{{ runsError }}
      </div>
      <div v-else-if="!runs.length" class="mp-placeholder compact">
        <History :size="22" />
        <b>暂无历史运行</b>
        <span>完成一次控制程序解析后，历史记录会出现在这里。</span>
      </div>
      <ul v-else class="mp-run-list">
        <li v-for="run in runs" :key="run.name" :class="{ active: currentRunName === run.name }">
          <div class="mp-run-main">
            <b>{{ run.time || run.name }}</b>
            <small>
              {{ run.plc || '未知 PLC' }} · {{ run.unitCount }} 个单元 ·
              {{ run.hasVariables ? `${run.variableCount} 个变量` : '未提取变量' }}
            </small>
          </div>
          <code class="mp-run-sha">{{ run.sha256 ? `${run.sha256.slice(0, 12)}…` : '—' }}</code>
          <button
            class="mp-btn"
            type="button"
            :disabled="isRunning || starting"
            @click="openRun(run.name)"
          >
            {{ currentRunName === run.name ? '当前' : '查看' }}
          </button>
        </li>
      </ul>
    </section>

    <section v-if="result" class="mp-card tp-results">
      <div class="mp-card-head">
        <div><FileText :size="16" /><h2>控制程序</h2></div>
        <span class="mp-chip ok"><CheckCircle2 :size="13" />解析成功 · {{ result.units.length }} 个单元</span>
      </div>

      <div class="tp-export-actions">
        <span class="tp-export-label">导出</span>
        <button class="mp-btn" type="button" @click="exportXlsx"><Download :size="13" />Excel</button>
        <button class="mp-btn" type="button" :disabled="!hasVariables" @click="exportCsv">变量表 CSV</button>
        <button class="mp-btn" type="button" :disabled="!hasVariables" @click="exportVariablesMd">变量表 Markdown</button>
        <button class="mp-btn" type="button" @click="exportReport">分析报告</button>
        <button class="mp-btn" type="button" @click="exportEvidence">验收证据</button>
        <button class="mp-btn" type="button" @click="exportJson">结果 JSON</button>
      </div>

      <div class="tp-table-toolbar">
        <input v-model="unitSearch" type="text" placeholder="搜索单元名称 / 类型…" />
        <span class="mp-muted">显示 {{ filteredUnits.length }} / {{ units.length }}</span>
      </div>

      <div class="mp-table-wrap">
        <table class="mp-table">
          <thead>
            <tr><th>名称</th><th>类型</th><th>字符数</th><th>解析状态</th></tr>
          </thead>
          <tbody>
            <template v-for="unit in filteredUnits" :key="unit.index">
              <tr class="tp-unit-row" @click="toggleUnit(unit.index)">
                <td>
                  <span class="tp-caret">{{ expanded.includes(unit.index) ? '▾' : '▸' }}</span>
                  <b>{{ unit.name }}</b>
                </td>
                <td>{{ unit.kind }}</td>
                <td class="mono">{{ unit.chars }}</td>
                <td><span class="mp-tag ok">{{ unit.status }}</span></td>
              </tr>
              <tr v-if="expanded.includes(unit.index)">
                <td colspan="4" class="tp-source-cell">
                  <pre class="tp-source">{{ unit.text }}</pre>
                </td>
              </tr>
            </template>
            <tr v-if="!filteredUnits.length">
              <td colspan="4" class="mp-empty">{{ units.length ? '没有符合筛选条件的单元' : '没有解析出控制程序源码' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="tp-var-actions">
        <button
          class="mp-btn primary"
          type="button"
          :disabled="variablesBusy || !finished"
          @click="runVariables"
        >
          <LoaderCircle v-if="variablesBusy" :size="15" class="mp-spin" />
          <Activity v-else :size="15" />关键变量属性提取
        </button>
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
              <option value="未知">未知</option>
            </select>
            <select v-model="varCategoryFilter" aria-label="类别筛选">
              <option value="all">全部类别</option>
              <option value="输入">输入</option>
              <option value="输出">输出</option>
              <option value="内部">内部</option>
              <option value="未知">未知</option>
            </select>
            <select v-model="varQualityFilter" aria-label="质量筛选">
              <option value="all">全部质量</option>
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
            <label class="tp-check"><input v-model="varHasRange" type="checkbox" />仅看有值域</label>
            <span class="mp-muted">显示 {{ filteredVariables.length }} / {{ allVariables.length }}</span>
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
          <div v-else class="mp-table-wrap">
            <table class="mp-table tp-var-table">
              <thead>
                <tr>
                  <th>所属单元</th><th>变量名</th><th>类型</th><th>类别</th>
                  <th>值域范围 / 相关常量</th><th>依据</th><th>质量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in filteredVariables" :key="`${item.row.unit}-${item.row.name}-${item.row.category}`">
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
        </template>
        <p v-if="!result.declarations" class="tp-var-note">
          类型与类别为按代码用法推断，仅供参考；值域依据见「依据」列。
        </p>
      </template>
    </section>
  </div>
</template>
