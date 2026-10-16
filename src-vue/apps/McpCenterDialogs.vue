<script setup lang="ts">
import DsDialog from "../design-system/DsDialog.vue";
import DsButton from "../design-system/DsButton.vue";
import DsTextField from "../design-system/DsTextField.vue";
import {
  LOCAL_SERVER_KEYS,
  TRANSPORT_LABEL,
  LOCATION_LABEL,
  asText,
  type DialogKind,
  type Form,
  type McpConnection,
} from "./mcp-meta";

/**
 * MCP 中心的三个对话框（新建 / 编辑 / 删除）—— 对齐 src/mcp/McpCenter.tsx 的 dialogs 片段。
 *
 * 单独一个组件是为了让"空列表"和"有列表"两个根分支共用同一份 dialogs（React 里就是一个变量），
 * DOM 与 class 名逐项一致；凭据字段在关闭时由父组件清空。
 */
const props = defineProps<{
  dialog: DialogKind;
  form: Form;
  busy: string | null;
  current: McpConnection | null;
}>();
const emit = defineEmits<{
  close: [];
  "update:form": [form: Form];
  submit: [kind: "create" | "edit" | "delete"];
}>();

function patch(p: Partial<Form>) {
  emit("update:form", { ...props.form, ...p });
}
function onTransport(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  patch({ transport: v === "http" ? "http" : "stdio" });
}
function onLocation(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  patch({ location: v === "REMOTE_SERVICE" ? "REMOTE_SERVICE" : "LOCAL_DEVICE" });
}
function onAuthMode(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  patch({ authMode: v === "BEARER" ? "BEARER" : "NONE" });
}
function onServerKey(e: Event) {
  patch({ serverKey: (e.target as HTMLSelectElement).value });
}
function onVisibility(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  patch({ visibility: v === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL" });
}
</script>

<template>
  <!-- 新建 -->
  <DsDialog :open="dialog === 'create'" title="新建 MCP 连接" @close="emit('close')">
    <div class="mcp-form" data-mcp-dialog="create">
      <DsTextField
        label="名称"
        data-mcp-field="name"
        :model-value="form.name"
        @update:model-value="patch({ name: $event })"
      />
      <label class="mcp-field">
        <span>传输</span>
        <select data-mcp-field="transport" :value="form.transport" @change="onTransport">
          <option value="stdio">stdio（本地进程）</option>
          <option value="http">http（远程服务）</option>
        </select>
      </label>
      <label class="mcp-field">
        <span>执行位置</span>
        <select data-mcp-field="location" :value="form.location" @change="onLocation">
          <option value="LOCAL_DEVICE">本地设备</option>
          <option value="REMOTE_SERVICE">远程服务</option>
        </select>
      </label>
      <template v-if="form.transport === 'stdio'">
        <label class="mcp-field">
          <span>本地服务</span>
          <select data-mcp-field="serverKey" :value="form.serverKey" @change="onServerKey">
            <option v-for="k in LOCAL_SERVER_KEYS" :key="k" :value="k">{{ k }}</option>
          </select>
          <small class="mcp-hint">
            本地连接只接受白名单服务键：主进程把它映射到受控程序与固定参数，界面不提供任意命令行。
          </small>
        </label>
      </template>
      <template v-else>
        <DsTextField
          label="端点地址"
          data-mcp-field="url"
          placeholder="https://"
          :model-value="form.url"
          @update:model-value="patch({ url: $event })"
        />
        <small class="mcp-hint" data-mcp-hint="endpoint">
          端点范围由主进程按地址推导并写进记录（本机 → LOCALHOST，公网 https → REMOTE_HTTPS，
          局域网默认拒绝），界面不提供手选。只接受 http(s)，禁止 file://、元数据地址与 URL
          内嵌凭据。
        </small>
      </template>
      <label class="mcp-field">
        <span>授权方式</span>
        <select data-mcp-field="authMode" :value="form.authMode" @change="onAuthMode">
          <option value="NONE">无需授权 NONE</option>
          <option value="BEARER">Bearer 凭据 BEARER</option>
        </select>
      </label>
      <DsTextField
        v-if="form.authMode === 'BEARER'"
        label="凭据"
        type="password"
        data-mcp-field="credentialSecret"
        hint="只写不读：送出后不再显示，界面与命令返回值都不含凭据本身。"
        :model-value="form.credentialSecret"
        @update:model-value="patch({ credentialSecret: $event })"
      />
      <label class="mcp-field">
        <span>可见性</span>
        <select data-mcp-field="visibility" :value="form.visibility" @change="onVisibility">
          <option value="PERSONAL">仅本人 PERSONAL</option>
          <option value="ORGANIZATION">组织 ORGANIZATION</option>
        </select>
      </label>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">取消</DsButton>
      <DsButton
        variant="primary"
        data-mcp-submit="create"
        :status="busy === 'create' ? 'loading' : 'idle'"
        @click="emit('submit', 'create')"
      >
        新建
      </DsButton>
    </template>
  </DsDialog>

  <!-- 编辑 -->
  <DsDialog :open="dialog === 'edit'" title="编辑 MCP 连接" @close="emit('close')">
    <div class="mcp-form" data-mcp-dialog="edit">
      <p v-if="current" class="mcp-muted" data-mcp-edit-fixed>
        传输 {{ TRANSPORT_LABEL[current.transport || ""] || asText(current.transport) }} · 执行位置
        {{ LOCATION_LABEL[current.location || ""] || asText(current.location) }}
        。两项在建连接时确定，要改请新建连接。
      </p>
      <DsTextField
        label="名称"
        data-mcp-field="name"
        :model-value="form.name"
        @update:model-value="patch({ name: $event })"
      />
      <template v-if="form.transport === 'stdio'">
        <label class="mcp-field">
          <span>本地服务</span>
          <select data-mcp-field="serverKey" :value="form.serverKey" @change="onServerKey">
            <option v-for="k in LOCAL_SERVER_KEYS" :key="k" :value="k">{{ k }}</option>
          </select>
        </label>
      </template>
      <template v-else>
        <DsTextField
          label="端点地址"
          data-mcp-field="url"
          placeholder="https://"
          :model-value="form.url"
          @update:model-value="patch({ url: $event })"
        />
        <small class="mcp-hint">端点范围由主进程按地址推导，界面不提供手选。</small>
      </template>
      <label class="mcp-field">
        <span>授权方式</span>
        <select data-mcp-field="authMode" :value="form.authMode" @change="onAuthMode">
          <option value="NONE">无需授权 NONE</option>
          <option value="BEARER">Bearer 凭据 BEARER</option>
        </select>
      </label>
      <DsTextField
        v-if="form.authMode === 'BEARER'"
        label="更新凭据"
        type="password"
        data-mcp-field="credentialSecret"
        hint="留空表示不改动；新凭据送出后即从界面消失。"
        :model-value="form.credentialSecret"
        @update:model-value="patch({ credentialSecret: $event })"
      />
      <label class="mcp-field">
        <span>可见性</span>
        <select data-mcp-field="visibility" :value="form.visibility" @change="onVisibility">
          <option value="PERSONAL">仅本人 PERSONAL</option>
          <option value="ORGANIZATION">组织 ORGANIZATION</option>
        </select>
      </label>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">取消</DsButton>
      <DsButton
        variant="primary"
        data-mcp-submit="edit"
        :status="busy === 'edit' ? 'loading' : 'idle'"
        @click="emit('submit', 'edit')"
      >
        保存
      </DsButton>
    </template>
  </DsDialog>

  <!-- 删除 -->
  <DsDialog :open="dialog === 'delete'" title="删除连接" @close="emit('close')">
    <div data-mcp-dialog="delete">
      <p>
        将删除连接「{{ current ? asText(current.name, current.connectionId) : "" }}」及它的能力快照与测试日志。
      </p>
      <p class="mcp-muted">
        删除后不可恢复；远端服务本身不会被改动。请确认当前选中的就是这一个连接。
      </p>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">取消</DsButton>
      <DsButton variant="danger" data-mcp-submit="delete" @click="emit('submit', 'delete')">删除</DsButton>
    </template>
  </DsDialog>
</template>
