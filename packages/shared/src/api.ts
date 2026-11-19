export interface SystemInfoRequest {
  id: string;
  method: "system.info";
}

export interface SystemInfo {
  version: string;
  dataDir: string;
  harnesses: ("claude-code" | "codex")[];
  memoryBytes: number;
}

export interface SystemInfoResponse {
  id: string;
  result: SystemInfo;
}

export type * from "./store";
