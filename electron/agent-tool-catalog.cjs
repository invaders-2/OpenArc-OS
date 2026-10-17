'use strict';

const { capabilityMetadata } = require('./agent-contracts.cjs');
const { FILE_TOOLS } = require('./agent-builtin-tools.cjs');

/**
 * @typedef {'system'|'file'|'app'|'mcp'|'skill'} ToolSource
 * @typedef {'read'|'write'|'delete'|'external'|'system'} ToolRisk
 * @typedef {'ready'|'pending'|'disabled'|'unavailable'} ToolStatus
 */

const ALL_SOURCES = ['system', 'file', 'app', 'mcp', 'skill'];

const EMPTY_SCHEMA = { type: 'object', properties: {} };

const DEFAULT_CONFIG = { sources: {}, auth: null, weather: null, clock: null };

let config = { ...DEFAULT_CONFIG };

function configureToolCatalog(next = {}) {
  config = {
    sources: next.sources || {},
    auth: next.auth || null,
    weather: next.weather || null,
    clock: next.clock || null,
  };
  return config;
}

function resetToolCatalogForTests() {
  config = { ...DEFAULT_CONFIG };
}

function functionTool(tool) {
  const hints = tool.whenToUse.length ? `\n适用场景：${tool.whenToUse.join('；')}` : '';
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: `[${tool.title}] ${tool.description}${hints}`,
      parameters: tool.inputSchema || EMPTY_SCHEMA,
    },
    x_dx_capability: capabilityMetadata({
      id: tool.capabilityId || `${tool.source}:${tool.sourceId}:${tool.name}`,
      domain: tool.domain || (tool.source === 'app' ? `app.${tool.appId || tool.sourceId}` : tool.source),
      intents: tool.intents?.length ? tool.intents : [tool.capabilityId || `${tool.source}.${tool.name}`],
      appId: tool.appId,
      requiredContext: tool.requiredContext,
    }),
  };
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sourceEntry(name) {
  const entry = config.sources[name];
  return entry && typeof entry.list === 'function' ? entry : null;
}

function sourceList(name) {
  const entry = sourceEntry(name);
  return entry ? entry.list() || [] : null;
}

function sourceCall(name) {
  const entry = config.sources[name];
  return entry && typeof entry.call === 'function' ? entry.call.bind(entry) : null;
}

const SOURCE_FALLBACKS = {
  system: {
    name: 'system_capability_registry', title: '系统能力注册表',
    description: '系统媒体能力注册表未接入，无法枚举系统能力工具。',
    statusText: '系统能力注册表未注入，暂不可用', source: 'system', sourceId: 'media-capability', domain: 'media',
  },
  app: {
    name: 'app_developer_registry', title: '开发者应用注册表',
    description: '开发者应用注册表未接入，无法枚举 APP 声明的 Agent 工具。',
    statusText: '开发者应用注册表未注入，暂不可用', source: 'app', sourceId: 'developer-apps', domain: 'app',
  },
  mcp: {
    name: 'mcp_registry', title: 'MCP 注册表',
    description: 'MCP 服务器注册表未接入，无法枚举 MCP 工具。',
    statusText: 'MCP 注册表未注入，暂不可用', source: 'mcp', sourceId: 'mcp', domain: 'mcp',
  },
  skill: {
    name: 'skill_registry', title: '技能注册表',
    description: '技能注册表未接入，无法枚举可暴露给 Agent 的技能。',
    statusText: 'B4 技能批次未落地，技能来源暂不可用', source: 'skill', sourceId: 'skills', domain: 'skill',
  },
  canvas: {
    name: 'app_canvas_registry', title: 'Canvas 内核能力',
    description: 'Canvas 内核能力注册表未接入，无法枚举画布内核能力。',
    statusText: 'Canvas 内核能力批次未落地，暂不可用', source: 'app', sourceId: 'canvas-kernel', domain: 'app.canvas',
  },
};

function unavailableDescriptor(spec) {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    source: spec.source,
    sourceId: spec.sourceId,
    enabled: false,
    executable: false,
    status: 'unavailable',
    statusText: spec.statusText,
    inputSchema: EMPTY_SCHEMA,
    permissions: [],
    risk: 'system',
    sideEffects: [],
    whenToUse: [],
    domain: spec.domain,
    intents: [spec.name],
    handler: { type: 'unavailable' },
  };
}

function canUseAppPermission(actor, permission) {
  const auth = config.auth;
  if (auth && typeof auth.canUseAppPermission === 'function') return Boolean(auth.canUseAppPermission(actor, permission));
  return false;
}

async function getWeather(city) {
  const weather = config.weather;
  if (!weather || typeof weather.getWeather !== 'function') throw new Error('天气服务未接入');
  return weather.getWeather(city);
}

function callSkill(skillId, args, ctx) {
  const call = sourceCall('skill');
  if (!call) throw new Error('技能执行服务未接入');
  return call(skillId, args, ctx);
}

function callMcp(toolName, args, ctx) {
  const call = sourceCall('mcp');
  if (!call) throw new Error('MCP 执行服务未接入');
  return call(toolName, args, ctx);
}

function systemTools() {
  return [
    {
      name: 'open_app',
      title: '打开应用',
      description: '打开一个 DX OS 应用窗口。',
      source: 'system',
      sourceId: 'desktop',
      enabled: true,
      executable: true,
      status: 'ready',
      statusText: '客户端可执行',
      inputSchema: { type: 'object', properties: { app: { type: 'string', description: '应用 id 或名称，如 music/settings/files/market' } }, required: ['app'] },
      permissions: [],
      risk: 'read',
      sideEffects: ['open:window'],
      whenToUse: ['用户要求打开、启动、进入或切换到某个应用时'],
      domain: 'system.app',
      intents: ['app.open'],
      handler: { type: 'client' },
    },
    {
      name: 'music_play',
      title: '播放音乐',
      description: '按关键词播放本地音乐，匹配歌名、歌手、专辑或目录。',
      source: 'system',
      sourceId: 'music',
      appId: 'music',
      enabled: true,
      executable: true,
      status: 'ready',
      statusText: '客户端可执行',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, shuffle: { type: 'boolean' } } },
      permissions: ['music.play'],
      risk: 'read',
      sideEffects: ['play:music'],
      whenToUse: ['用户要求播放某首歌、某个歌手、某类音乐或继续听音乐时'],
      domain: 'system.music',
      intents: ['music.play'],
      handler: { type: 'client' },
    },
    {
      name: 'music_control',
      title: '音乐控制',
      description: '控制当前音乐播放状态。',
      source: 'system',
      sourceId: 'music',
      appId: 'music',
      enabled: true,
      executable: true,
      status: 'ready',
      statusText: '客户端可执行',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'next', 'prev', 'stop'] } }, required: ['action'] },
      permissions: ['music.play'],
      risk: 'read',
      sideEffects: ['control:music'],
      whenToUse: ['用户要求暂停、继续、下一首、上一首或停止播放时'],
      domain: 'system.music',
      intents: ['music.control'],
      handler: { type: 'client' },
    },
  ];
}

function fileToolRisk(mutates, name) {
  if (name === 'fs_delete') return 'delete';
  return mutates ? 'write' : 'read';
}

function fileToolSideEffects(mutates, name) {
  if (!mutates) return [];
  if (name === 'fs_delete') return ['delete:files'];
  return ['write:files'];
}

function fileTools() {
  const injected = sourceList('file');
  const declarations = injected === null ? FILE_TOOLS : injected;
  return declarations.map((tool) => {
    const risk = fileToolRisk(tool.mutates, tool.name);
    return {
      name: tool.name,
      title: tool.name,
      description: tool.description,
      source: 'file',
      sourceId: 'project',
      enabled: true,
      executable: true,
      status: 'ready',
      statusText: '项目文件工具可执行',
      inputSchema: tool.parameters,
      permissions: [risk === 'read' ? 'files.read' : 'files.write'],
      risk,
      sideEffects: fileToolSideEffects(tool.mutates, tool.name),
      whenToUse: ['需要读取、创建、修改、移动、复制或删除项目文件时'],
      domain: 'file',
      intents: [risk === 'read' ? 'file.read' : risk === 'delete' ? 'file.delete' : 'file.write'],
      requiredContext: ['project'],
      handler: { type: 'file-tool', toolName: tool.name },
    };
  });
}

function isWeatherTool(tool) {
  const text = `${tool.name} ${tool.title} ${tool.description} ${tool.permission || ''}`.toLowerCase();
  return text.includes('weather') || text.includes('天气');
}

function installedSkillStatus(skillId) {
  const skills = sourceList('skill');
  const skill = (skills || []).find((item) => item.id === skillId);
  if (!skill) return { executable: false, status: 'pending', statusText: `等待安装 Skill：${skillId}` };
  if (!skill.enabled) return { executable: false, status: 'disabled', statusText: `Skill 已安装但未启用：${skill.name}` };
  return { executable: true, status: 'ready', statusText: `已安装并启用 Skill：${skill.name}` };
}

function installedMcpStatus(serverId, toolName) {
  const servers = sourceList('mcp');
  const server = (servers || []).find((item) => item.id === serverId);
  if (!server) return { executable: false, status: 'pending', statusText: `等待安装 MCP：${serverId}` };
  if (!server.enabled) return { executable: false, status: 'disabled', statusText: `MCP 已安装但未启用：${server.name}` };
  if (server.status !== 'connected') return { executable: false, status: 'unavailable', statusText: `MCP ${server.status || '未连接'}：${server.name}` };
  if (toolName && !(server.tools || []).some((tool) => tool.name === toolName)) {
    return { executable: false, status: 'pending', statusText: `MCP 已连接，等待工具：${toolName}` };
  }
  return { executable: true, status: 'ready', statusText: `已连接 MCP：${server.name}` };
}

function appToolServerStatus(tool) {
  const handler = tool.handler || { type: tool.handlerType };
  if (handler.type === 'skill' && handler.skillId) return installedSkillStatus(handler.skillId);
  if (handler.type === 'mcp-tool' && handler.serverId) return installedMcpStatus(handler.serverId, handler.toolName);
  if (handler.type === 'frontend-bridge' && isWeatherTool(tool)) return { executable: true, status: 'ready', statusText: '已映射系统天气能力' };
  return {
    executable: false,
    status: 'pending',
    statusText: handler.type === 'app-api'
      ? '已登记，等待后端执行入口授权'
      : '已登记，等待前端桥接窗口在线',
  };
}

function appTool(packId, appName, tool, actor) {
  const serverStatus = appToolServerStatus(tool);
  const allowed = !tool.permission || canUseAppPermission(actor, tool.permission);
  const statusText = serverStatus.executable
    ? allowed
      ? `已授权，${serverStatus.statusText}`
      : '当前账户没有打开此 APP 的权限'
    : serverStatus.statusText;
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description || `${appName} 声明的 Agent 工具。`,
    source: 'app',
    sourceId: packId,
    appId: packId,
    enabled: serverStatus.executable && allowed,
    executable: serverStatus.executable && allowed,
    status: serverStatus.executable ? (allowed ? 'ready' : 'disabled') : serverStatus.status,
    statusText,
    inputSchema: tool.inputSchema || EMPTY_SCHEMA,
    outputSchema: tool.outputSchema,
    permissions: tool.permission ? [tool.permission] : [],
    risk: tool.risk,
    sideEffects: tool.sideEffects || [],
    whenToUse: tool.whenToUse || [],
    domain: `app.${packId}`,
    intents: [tool.name],
    requiredContext: ['app'],
    confirmation: tool.confirmation,
    handler: tool.handler || { type: tool.handlerType },
  };
}

function developerTools(actor) {
  const apps = sourceList('app');
  if (apps === null) return [unavailableDescriptor(SOURCE_FALLBACKS.app)];
  return apps.flatMap((pack) => (pack.capabilities?.tools || []).map((tool) => appTool(pack.id, pack.manifest.name, tool, actor)));
}

function canvasTools() {
  const descriptors = sourceList('canvas');
  if (descriptors === null) return [unavailableDescriptor(SOURCE_FALLBACKS.canvas)];
  return descriptors;
}

function mcpTools() {
  const servers = sourceList('mcp');
  if (servers === null) return [unavailableDescriptor(SOURCE_FALLBACKS.mcp)];
  return servers.flatMap((server) => (server.tools || []).map((tool) => {
    const connected = server.enabled && server.status === 'connected';
    return {
      name: `mcp__${safeName(server.id)}__${safeName(tool.name)}`,
      title: tool.name,
      description: `[MCP:${server.name}] ${tool.description || tool.name}`,
      source: 'mcp',
      sourceId: server.id,
      enabled: connected,
      executable: connected,
      status: connected ? 'ready' : server.enabled ? 'unavailable' : 'disabled',
      statusText: connected ? 'MCP 已连接' : server.enabled ? `MCP ${server.status || '未连接'}` : 'MCP 已停用',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : EMPTY_SCHEMA,
      permissions: ['mcp.call'],
      risk: 'external',
      sideEffects: ['call:mcp'],
      whenToUse: [],
      domain: 'mcp',
      intents: [`mcp.${server.id}.${tool.name}`],
      handler: { type: 'mcp-tool', serverId: server.id, toolName: tool.name },
    };
  }));
}

function skillTools() {
  const skills = sourceList('skill');
  if (skills === null) return [unavailableDescriptor(SOURCE_FALLBACKS.skill)];
  return skills.filter((skill) => skill.exposure === 'agent' && skill.allowImplicitInvocation !== false).map((skill) => ({
    name: `skill__${skill.id}`,
    title: skill.name,
    description: `[技能:${skill.name}] ${skill.description}`,
    source: 'skill',
    sourceId: skill.id,
    enabled: skill.enabled,
    executable: skill.enabled,
    status: skill.enabled ? 'ready' : 'disabled',
    statusText: skill.enabled ? 'Skill 已启用' : 'Skill 已停用',
    inputSchema: skill.inputSchema || EMPTY_SCHEMA,
    permissions: skill.v2 ? [
      skill.v2.permissions.readsFiles ? 'files.read' : '',
      skill.v2.permissions.writesFiles ? 'files.write' : '',
      skill.v2.permissions.network ? 'network.fetch' : '',
      ...skill.v2.permissions.sensitive,
    ].filter(Boolean) : [],
    risk: skill.v2?.permissions.network ? 'external' : skill.v2?.permissions.writesFiles ? 'write' : 'read',
    sideEffects: skill.v2?.permissions.writesFiles ? ['write:files'] : [],
    whenToUse: skill.v2?.triggers || [],
    domain: 'skill',
    intents: [`skill.${skill.id}`],
    handler: { type: 'skill', skillId: skill.id },
  }));
}

const SYSTEM_CAPABILITY_IDS = {
  media_generate_image: 'media.image.generate',
  media_midjourney: 'media.image.midjourney',
  media_upscale_image: 'media.image.upscale',
  media_generate_video: 'media.video.generate',
  media_edit_image: 'media.image.edit',
  media_batch_image: 'media.image.batch_edit',
  media_describe_image: 'media.image.inspect',
  media_text_to_speech: 'media.audio.synthesize',
  media_transcribe_audio: 'media.audio.transcribe',
  media_generate_music: 'media.audio.music_generate',
};

const SYSTEM_CAPABILITY_INTENTS = {
  media_generate_video: [
    'media.video.generate', 'media.video.image_to_video', 'media.video.first_last_frame',
    'media.video.multi_reference', 'media.video.video_to_video', 'media.video.audio_reference', 'media.video.multimodal',
  ],
};

function systemCapabilityDomain(toolName) {
  const id = SYSTEM_CAPABILITY_IDS[toolName] || 'media';
  if (id.startsWith('media.image.')) return 'media.image';
  if (id.startsWith('media.video.')) return 'media.video';
  if (id.startsWith('media.audio.')) return 'media.audio';
  return 'media';
}

function capabilityTools() {
  const capabilities = sourceList('system');
  if (capabilities === null) return [unavailableDescriptor(SOURCE_FALLBACKS.system)];
  return capabilities.map(({ toolName, skillId, definition }) => ({
    name: toolName,
    capabilityId: SYSTEM_CAPABILITY_IDS[toolName],
    title: definition.name,
    description: definition.description,
    source: 'system',
    sourceId: 'media-capability',
    enabled: definition.enabled,
    executable: definition.enabled,
    status: definition.enabled ? 'ready' : 'disabled',
    statusText: definition.enabled ? '系统能力可用' : '系统能力已停用',
    inputSchema: definition.inputSchema || EMPTY_SCHEMA,
    permissions: [],
    risk: ['image_describe', 'audio_transcribe'].includes(definition.kind) ? 'read' : 'external',
    sideEffects: ['image_describe', 'audio_transcribe'].includes(definition.kind) ? [] : ['create:artifact', 'call:model-provider'],
    whenToUse: [],
    domain: systemCapabilityDomain(toolName),
    intents: SYSTEM_CAPABILITY_INTENTS[toolName] || [SYSTEM_CAPABILITY_IDS[toolName] || `media.${definition.kind}`],
    handler: { type: 'system-capability', skillId },
  }));
}

function mergeDescriptors(groups) {
  // Function tool names must stay unique for the model-facing schema, so the
  // first declaration of a name wins and later duplicates are dropped.
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const descriptor of group) {
      if (seen.has(descriptor.name)) continue;
      seen.add(descriptor.name);
      merged.push(descriptor);
    }
  }
  return merged;
}

function listToolDescriptors(actor) {
  return mergeDescriptors([
    systemTools(),
    capabilityTools(),
    fileTools(),
    developerTools(actor),
    canvasTools(),
    mcpTools(),
    skillTools(),
  ]);
}

function descriptorsForSource(source, actor) {
  if (source === 'system') return mergeDescriptors([systemTools(), capabilityTools()]);
  if (source === 'file') return mergeDescriptors([fileTools()]);
  if (source === 'app') return mergeDescriptors([developerTools(actor), canvasTools()]);
  if (source === 'mcp') return mergeDescriptors([mcpTools()]);
  return mergeDescriptors([skillTools()]);
}

function toolCatalogSnapshot(options = {}) {
  let descriptors = options.source ? descriptorsForSource(options.source, options.actor) : listToolDescriptors(options.actor);
  if (options.sourceId) descriptors = descriptors.filter((tool) => tool.sourceId === options.sourceId);
  if (options.appId) descriptors = descriptors.filter((tool) => tool.appId === options.appId || tool.sourceId === options.appId);
  if (options.executableOnly) descriptors = descriptors.filter((tool) => tool.enabled && tool.executable);
  const tools = descriptors.filter((tool) => tool.enabled && tool.executable).map(functionTool);
  const sources = { system: 0, file: 0, app: 0, mcp: 0, skill: 0 };
  for (const tool of descriptors) {
    sources[tool.source] = (sources[tool.source] || 0) + 1;
  }
  return {
    descriptors,
    tools,
    summary: {
      total: descriptors.length,
      ready: descriptors.filter((tool) => tool.status === 'ready').length,
      pending: descriptors.filter((tool) => tool.status === 'pending').length,
      sources,
    },
  };
}

function weatherSentence(wx) {
  const today = wx.daily[0];
  return `${wx.city}当前${wx.current.text}，气温 ${wx.current.temp}°，体感 ${wx.current.feels}°，今日最高 ${today?.max ?? '--'}°、最低 ${today?.min ?? '--'}°。`;
}

function ensurePermissions(actor, permissions) {
  for (const permission of permissions) {
    if (!canUseAppPermission(actor, permission)) throw new Error(`当前账户没有打开此 APP 的权限：${permission}`);
  }
}

async function runCatalogTool(name, args, actor, options = {}) {
  const descriptor = listToolDescriptors(actor).find((tool) => tool.name === name && (!options.sourceId || tool.sourceId === options.sourceId));
  if (!descriptor) throw new Error(`未知工具：${name}`);
  if (descriptor.handler.type === 'client') {
    // task-69：客户端工具需要宿主上下文（如 app.canvas.current）。后台任务没有该上下文时
    // 给出非重试的结构化错误，避免模型把"当前无法执行"当成暂时失败而无界重试。
    const requiredContext = Array.isArray(descriptor.requiredContext) ? descriptor.requiredContext.filter(Boolean).map(String) : [];
    const error = new Error(requiredContext.includes('app.canvas.current')
      ? '该工具需要画布前台上下文（app.canvas.current）。当前任务没有可用画布窗口，已停止重试；请先在画布中打开目标后再发起。'
      : '此工具由桌面客户端执行，不能通过服务端直接运行。');
    if (requiredContext.length) {
      error.code = 'TOOL_CONTEXT_UNAVAILABLE';
      error.retryable = false;
      error.requiredContext = requiredContext;
    }
    throw error;
  }
  if (descriptor.handler.type === 'system-capability' && descriptor.handler.skillId) {
    if (!actor) throw new Error('请先登录');
    return callSkill(descriptor.handler.skillId, args, {
      userId: actor.id,
      rootId: typeof args.__rootId === 'string' ? args.__rootId : undefined,
      providerId: typeof args.__providerId === 'string' ? args.__providerId : undefined,
      model: typeof args.__model === 'string' ? args.__model : undefined,
      imageProviderId: typeof args.__imageProviderId === 'string' ? args.__imageProviderId : undefined,
      imageModel: typeof args.__imageModel === 'string' ? args.__imageModel : undefined,
      audioProviderId: typeof args.__audioProviderId === 'string' ? args.__audioProviderId : undefined,
      audioModel: typeof args.__audioModel === 'string' ? args.__audioModel : undefined,
    });
  }
  if (descriptor.source === 'app') {
    ensurePermissions(actor, descriptor.permissions);
    if (!descriptor.executable) throw new Error(descriptor.statusText || '此 APP 工具暂不可执行');
    const pack = (sourceList('app') || []).find((item) => item.id === descriptor.sourceId);
    const tool = pack?.capabilities?.tools?.find((item) => item.name === name);
    if (!pack || !tool) throw new Error(`未知 APP 工具：${name}`);
    const handler = tool.handler || { type: tool.handlerType };
    if (handler.type === 'frontend-bridge' && isWeatherTool(tool)) {
      const weather = await getWeather(String(args.city || '成都'));
      return { text: weatherSentence(weather), weather };
    }
    if (handler.type === 'skill' && handler.skillId) {
      const instruction = String(args.instruction || args.prompt || '').trim();
      const shouldAddWeather = /天气|weather/i.test(instruction);
      let finalInstruction = instruction;
      if (shouldAddWeather) {
        const weatherPermission = pack.capabilities.permissions.find((permission) => /weather|天气/i.test(permission));
        if (weatherPermission) ensurePermissions(actor, [weatherPermission]);
        const weather = await getWeather(String(args.city || '成都'));
        finalInstruction = `请用一句话回答用户问题。天气数据：${weatherSentence(weather)}\n用户问题：${instruction}`;
      }
      return callSkill(handler.skillId, { ...args, instruction: finalInstruction }, {
        userId: actor?.id,
        rootId: typeof args.__rootId === 'string' ? args.__rootId : undefined,
        providerId: typeof args.__providerId === 'string' ? args.__providerId : undefined,
        model: typeof args.__model === 'string' ? args.__model : undefined,
        imageProviderId: typeof args.__imageProviderId === 'string' ? args.__imageProviderId : undefined,
        imageModel: typeof args.__imageModel === 'string' ? args.__imageModel : undefined,
      });
    }
    if (handler.type === 'mcp-tool' && handler.serverId && handler.toolName) {
      return { text: await callMcp(handler.toolName, args || {}, { serverId: handler.serverId, actor }) };
    }
    throw new Error('此 APP 工具已登记，但当前执行器还没有安全映射。');
  }
  throw new Error(`工具 ${name} 暂未接入统一执行入口。`);
}

module.exports = {
  configureToolCatalog,
  resetToolCatalogForTests,
  listToolDescriptors,
  descriptorsForSource,
  toolCatalogSnapshot,
  runCatalogTool,
  weatherSentence,
  functionTool,
  safeName,
};


