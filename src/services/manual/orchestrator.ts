import { callExtract, ManualApiError } from './client';
import type { ManualDevice, ManualLogicRow, ManualSegment, ManualStage, ManualTopologyRow } from '../../domain/manual';

export type RunStatus = 'pending' | 'running' | 'done' | 'error';

export interface SegmentRun {
  index: number;
  pageStart: number;
  pageEnd: number;
  devices: ManualDevice[];
  topology: ManualTopologyRow[];
  logic: ManualLogicRow[];
  raw: Partial<Record<ManualStage, string>>;
  issues: string[];
  status: RunStatus;
  stage: ManualStage | null;
  error: string;
  model: string;
  elapsedMs: number;
}

export function createRun(segment: ManualSegment): SegmentRun {
  return {
    index: segment.index,
    pageStart: segment.pageStart,
    pageEnd: segment.pageEnd,
    devices: [],
    topology: [],
    logic: [],
    raw: {},
    issues: [],
    status: 'pending',
    stage: null,
    error: '',
    model: '',
    elapsedMs: 0,
  };
}

export interface RunOptions {
  segments: ManualSegment[];
  signal: AbortSignal;
  /** 每次阶段状态变化时回调，交给 Vue 更新界面。 */
  onUpdate: (run: SegmentRun) => void;
}

/**
 * 分段级流水线：设备 → 业务拓扑 → 控制逻辑。
 * 每段独立串行执行，单段失败不影响其余分段；缺少 API Key 等致命错误会立即中断整轮。
 */
export async function runExtraction({ segments, signal, onUpdate }: RunOptions): Promise<{ runs: SegmentRun[]; model: string }> {
  const runs: SegmentRun[] = [];
  let model = '';
  for (const segment of segments) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const t0 = Date.now();
    const run = createRun(segment);
    run.status = 'running';
    run.stage = 'devices';
    onUpdate({ ...run });

    try {
      const devices = await callExtract({ stage: 'devices', text: segment.text }, signal);
      model = devices.model || model;
      run.model = devices.model || run.model;
      run.raw.devices = devices.raw;
      run.devices = devices.data as ManualDevice[];
      run.issues.push(...devices.issues);

      run.stage = 'topology';
      onUpdate({ ...run });
      const topology = await callExtract({ stage: 'topology', text: segment.text, devices: run.devices }, signal);
      model = topology.model || model;
      run.model = topology.model || run.model;
      run.raw.topology = topology.raw;
      run.topology = topology.data as ManualTopologyRow[];
      run.issues.push(...topology.issues);

      run.stage = 'logic';
      onUpdate({ ...run });
      const logic = await callExtract({ stage: 'logic', text: segment.text, topology: run.topology }, signal);
      model = logic.model || model;
      run.model = logic.model || run.model;
      run.raw.logic = logic.raw;
      run.logic = logic.data as ManualLogicRow[];
      run.issues.push(...logic.issues);

      run.status = 'done';
      run.stage = null;
      run.elapsedMs = Date.now() - t0;
      onUpdate({ ...run });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      run.status = 'error';
      run.stage = null;
      run.elapsedMs = Date.now() - t0;
      run.error = error instanceof Error ? error.message : String(error);
      onUpdate({ ...run });
      if (error instanceof ManualApiError && error.fatal) throw error;
    }
    runs.push(run);
  }

  return { runs, model };
}
