export interface TrafficUnit {
  index: number;
  name: string;
  kind: string;
  chars: number;
  status: string;
  declared: boolean;
  streamOffset: string;
  text: string;
}

export interface TrafficResult {
  plc: string;
  port: number;
  session: string;
  imageBytes: number;
  records: number;
  sha256: string;
  declarations: boolean;
  stu: string | null;
  runDir: string;
  units: TrafficUnit[];
}

export interface TrafficVariable {
  unit: string;
  name: string;
  type: string;
  category: string;
  range: string;
  basis: string;
}

export type TrafficJobStatus = 'running' | 'done' | 'error';

export interface TrafficJobView {
  id: string;
  status: TrafficJobStatus;
  stage: string;
  percent: number;
  message: string;
  error: string;
  warnings: string[];
  result?: TrafficResult;
  variables?: TrafficVariable[];
  variablesError?: string;
  variablesRunning?: boolean;
}

export interface TrafficJobInput {
  ip: string;
  port: number;
  timeout: number;
}
