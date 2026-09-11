/** D2-02 · Window Manager 的类型声明。 */

import type { Area, Host, WindowCommand, WindowStateModel } from "./window-domain.cjs";

export type NativeIntent = {
  windowId: string;
  appId: string;
  url: string;
  present: boolean;
  focused: boolean;
  viewport: { x: number; y: number; width: number; height: number };
  occluders: { id: string; x: number; y: number; width: number; height: number }[];
};

export function areaOf(host: Host | undefined): Area;
export function maximizedBounds(host: Host | undefined): { x: number; y: number; w: number; h: number };
export function topmostVisible(state: WindowStateModel, exceptId: string | null): string | null;
export function raise(state: WindowStateModel, id: string): WindowStateModel;
export function clone(state: WindowStateModel): WindowStateModel;
/** 唯一的状态变更入口。未知命令原样返回原状态。 */
export function reduce(state: WindowStateModel, command: WindowCommand): WindowStateModel;
export function applyAll(state: WindowStateModel, commands: WindowCommand[]): WindowStateModel;
export function serialize(state: WindowStateModel): string;
export function deserialize(raw: unknown, areas?: Area[]): WindowStateModel;
export function nativeIntents(state: WindowStateModel, host?: Host): NativeIntent[];
export const WINDOW_COMMANDS: readonly string[];
export const SYSTEM_MUTATIONS: readonly string[];
export const REDUCERS: Record<string, (state: WindowStateModel, command: unknown) => WindowStateModel>;

declare const manager: {
  areaOf: typeof areaOf;
  maximizedBounds: typeof maximizedBounds;
  topmostVisible: typeof topmostVisible;
  raise: typeof raise;
  clone: typeof clone;
  reduce: typeof reduce;
  applyAll: typeof applyAll;
  serialize: typeof serialize;
  deserialize: typeof deserialize;
  nativeIntents: typeof nativeIntents;
  WINDOW_COMMANDS: typeof WINDOW_COMMANDS;
  SYSTEM_MUTATIONS: typeof SYSTEM_MUTATIONS;
  REDUCERS: typeof REDUCERS;
};
export default manager;
