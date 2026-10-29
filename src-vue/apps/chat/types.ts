/** 对话输入区与消息气泡共用的类型。 */
export type ChatFile = { path: string; name: string; size: number; mime?: string; kind: string; state?: "uploading" | "failed" | "ready"; error?: string; ref?: boolean; localUrl?: string };
export type ModelOpt = { configId: string; displayName: string; providerName: string };
export type Pick = { kind: "skill" | "mcp"; id: string; name: string };
export type SendPayload = { text: string; files: ChatFile[]; picks: Pick[]; modelConfigId: string | null };
