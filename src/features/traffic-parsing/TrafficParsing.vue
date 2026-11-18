<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileText,
  LoaderCircle,
  Play,
  Upload,
  XCircle,
} from 'lucide-vue-next';
import type { TrafficJobView, TrafficVariable } from '@/domain/traffic';
import {
  extractTrafficVariables,
  fetchTrafficJob,
  startTrafficJob,
} from '@/services/traffic/client';
import '@/features/manual-extraction/manual-extraction.css';
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

let pollTimer: number | null = null;

const result = computed(() => job.value?.result);
const units = computed(() => result.value?.units ?? []);
const isRunning = computed(() => job.value?.status === 'running');
const canStart = computed(() => !starting.value && !isRunning.value);
const finished = computed(() => job.value?.status === 'done');
const variablesEmpty = computed(() => variables.value !== null && variables.value.length === 0);
const variablesBusy = computed(() => variablesRunning.value || Boolean(job.value?.variablesRunning));

function stopPolling() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
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
    variables.value = await extractTrafficVariables(job.value.id);
  } catch (error) {
    variablesError.value = errorText(error);
  } finally {
    variablesRunning.value = false;
  }
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
          <div><Activity :size="16" /><h2>解析进度</h2></div>
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
          <span>填写 PLC 地址后点击「开始解析」，自动完成控制程序提取。</span>
        </div>

        <template v-else>
          <div class="mp-progress">
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

    <section v-if="result" class="mp-card tp-results">
      <div class="mp-card-head">
        <div><FileText :size="16" /><h2>控制程序</h2></div>
        <span class="mp-chip ok"><CheckCircle2 :size="13" />解析成功 · {{ result.units.length }} 个单元</span>
      </div>

      <div class="mp-table-wrap">
        <table class="mp-table">
          <thead>
            <tr><th>名称</th><th>类型</th><th>字符数</th><th>解析状态</th></tr>
          </thead>
          <tbody>
            <template v-for="unit in units" :key="unit.index">
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
            <tr v-if="!units.length">
              <td colspan="4" class="mp-empty">没有解析出控制程序源码</td>
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
        <div v-else class="mp-table-wrap">
          <table class="mp-table tp-var-table">
            <thead>
              <tr>
                <th>所属单元</th><th>变量名</th><th>类型</th><th>类别</th><th>值域范围 / 相关常量</th><th>依据</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in variables" :key="`${row.unit}-${row.name}-${row.category}`">
                <td class="tp-var-unit">{{ row.unit }}</td>
                <td><b>{{ row.name }}</b></td>
                <td>{{ row.type || '未知' }}</td>
                <td><span class="mp-tag type">{{ row.category }}</span></td>
                <td class="tp-var-range">{{ row.range }}</td>
                <td class="mp-evidence">{{ row.basis }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!result.declarations" class="tp-var-note">
          类型与类别为按代码用法推断，仅供参考；值域依据见「依据」列。
        </p>
      </template>
    </section>
  </div>
</template>
