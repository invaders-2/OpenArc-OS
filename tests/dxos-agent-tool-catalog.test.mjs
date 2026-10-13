import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../electron/agent-tool-catalog.cjs';
import builtin from '../electron/agent-builtin-tools.cjs';

const FILE_TOOL_COUNT = builtin.FILE_TOOLS.length;
const ACTOR = { id: 'u1', permissions: ['weather.read'] };

function fullSources() {
  return {
    system: {
      list: () => [
        {
          toolName: 'media_generate_image', skillId: 'skill-image',
          definition: { name: '生成图片', description: '生成一张图片', enabled: true, kind: 'image_generate', inputSchema: { type: 'object', properties: {} } },
        },
        {
          toolName: 'media_describe_image', skillId: 'skill-vision',
          definition: { name: '图片描述', description: '描述图片', enabled: false, kind: 'image_describe', inputSchema: { type: 'object', properties: {} } },
        },
      ],
    },
    app: {
      list: () => [{
        id: 'weather-pack',
        manifest: { name: '天气包' },
        capabilities: {
          permissions: ['weather.read'],
          tools: [
            { name: 'wx_now', title: '实时天气', description: '查询城市天气', permission: 'weather.read', risk: 'read', handler: { type: 'frontend-bridge' }, inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, whenToUse: ['用户询问天气时'] },
            { name: 'wx_skill', title: '天气问答', description: '结合天气回答问题', permission: 'weather.read', risk: 'read', handler: { type: 'skill', skillId: 'skill-weather' }, inputSchema: { type: 'object' } },
          ],
        },
      }],
    },
    mcp: {
      list: () => [{ id: 'fs server', name: '文件服务', enabled: true, status: 'connected', tools: [{ name: 'read.file', description: '读取文件', inputSchema: { type: 'object' } }] }],
      call: async (toolName, args, ctx) => ({ toolName, args, ctx }),
    },
    skill: {
      list: () => [
        { id: 'note', name: '笔记', description: '记录笔记', enabled: true, exposure: 'agent', inputSchema: { type: 'object' }, v2: { permissions: { readsFiles: false, writesFiles: true, network: false, sensitive: [] }, triggers: ['用户要记笔记时'] } },
        { id: 'hidden', name: '隐藏技能', description: '不暴露给 Agent', enabled: true, exposure: 'manual' },
        { id: 'skill-weather', name: '天气技能', description: '回答天气问题', enabled: true, exposure: 'agent', inputSchema: { type: 'object' }, v2: { permissions: { readsFiles: false, writesFiles: false, network: true, sensitive: [] }, triggers: ['天气问答'] } },
        { id: 'off', name: '停用技能', description: '未启用', enabled: false, exposure: 'agent' },
      ],
      call: async (skillId, args, ctx) => ({ skillId, args, ctx }),
    },
    canvas: {
      list: () => [{
        name: 'canvas_draw', title: '画布绘制', description: '在画布上绘制', source: 'app', sourceId: 'canvas-kernel',
        enabled: true, executable: true, status: 'ready', statusText: '内核可用', inputSchema: { type: 'object' },
        permissions: [], risk: 'read', sideEffects: [], whenToUse: [], handler: { type: 'client' },
      }],
    },
  };
}

function configureAll(sources = fullSources()) {
  catalog.configureToolCatalog({
    sources,
    auth: { canUseAppPermission: (actor, permission) => Boolean(actor && (actor.permissions || []).includes(permission)) },
    weather: { getWeather: async (city) => ({ city, current: { text: '晴', temp: 20, feels: 19 }, daily: [{ max: 25, min: 12 }] }) },
    clock: { now: () => 0 },
  });
  return sources;
}

function namesOf(descriptors) {
  return descriptors.map((descriptor) => descriptor.name);
}

beforeEach(() => {
  catalog.resetToolCatalogForTests();
});

describe('来源列举与合并', () => {
  it('合并七类来源并过滤不暴露的 Skill', () => {
    configureAll();
    const descriptors = catalog.listToolDescriptors(ACTOR);
    const names = namesOf(descriptors);

    assert.ok(names.includes('open_app'), '内置系统工具');
    assert.ok(names.includes('music_control'), '内置系统工具');
    assert.ok(names.includes('media_generate_image'), '系统能力');
    assert.ok(names.includes('fs_list'), '文件工具');
    assert.ok(names.includes('fs_delete'), '文件工具');
    assert.ok(names.includes('wx_now'), 'APP 工具');
    assert.ok(names.includes('wx_skill'), 'APP 工具');
    assert.ok(names.includes('canvas_draw'), 'Canvas 内核能力');
    assert.ok(names.includes('mcp__fs_server__read_file'), 'MCP 前缀命名');
    assert.ok(names.includes('skill__note'), 'Skill 前缀命名');
    assert.ok(names.includes('skill__off'), '未启用的 Skill 仍登记但不可执行');
    assert.equal(names.includes('skill__hidden'), false, 'exposure 非 agent 的 Skill 不进入目录');

    assert.equal(descriptors.length, 3 + 2 + FILE_TOOL_COUNT + 2 + 1 + 1 + 3);
  });

  it('未注入 file 来源时回退到内置 FILE_TOOLS', () => {
    const sources = fullSources();
    delete sources.file;
    configureAll(sources);
    const files = catalog.descriptorsForSource('file');
    assert.equal(files.length, FILE_TOOL_COUNT);
    assert.deepEqual(new Set(namesOf(files)), new Set(builtin.FILE_TOOLS.map((tool) => tool.name)));
  });

  it('按来源投影只返回该来源的工具', () => {
    configureAll();
    const mcp = catalog.toolCatalogSnapshot({ source: 'mcp', actor: ACTOR });
    assert.equal(mcp.descriptors.length, 1);
    assert.equal(mcp.descriptors[0].name, 'mcp__fs_server__read_file');
    assert.equal(catalog.descriptorsForSource('skill', ACTOR).every((tool) => tool.source === 'skill'), true);
    assert.equal(catalog.descriptorsForSource('system', ACTOR).every((tool) => tool.source === 'system'), true);
    assert.equal(catalog.descriptorsForSource('app', ACTOR).every((tool) => tool.source === 'app'), true);
  });
});

describe('来源缺失', () => {
  it('未提供的来源标记为 unavailable 并写明原因', () => {
    const sources = fullSources();
    delete sources.system;
    delete sources.app;
    delete sources.mcp;
    delete sources.skill;
    delete sources.canvas;
    configureAll(sources);

    const snap = catalog.toolCatalogSnapshot();
    const byName = new Map(snap.descriptors.map((descriptor) => [descriptor.name, descriptor]));

    for (const name of ['system_capability_registry', 'app_developer_registry', 'app_canvas_registry', 'mcp_registry', 'skill_registry']) {
      const descriptor = byName.get(name);
      assert.ok(descriptor, `缺少来源占位：${name}`);
      assert.equal(descriptor.status, 'unavailable', name);
      assert.equal(descriptor.enabled, false, name);
      assert.equal(descriptor.executable, false, name);
      assert.equal(typeof descriptor.statusText, 'string');
      assert.ok(descriptor.statusText.length > 0, name);
    }

    assert.match(byName.get('skill_registry').statusText, /B4 技能批次未落地/);
    assert.match(byName.get('app_developer_registry').statusText, /未注入/);
    assert.match(byName.get('mcp_registry').statusText, /未注入/);
    assert.equal(snap.tools.some((tool) => tool.function.name === 'skill_registry'), false, '占位不进入可执行工具');
  });

  it('只缺一个来源时该来源仍可被单独投影为不可用', () => {
    const sources = fullSources();
    delete sources.skill;
    configureAll(sources);
    const skills = catalog.descriptorsForSource('skill', ACTOR);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'skill_registry');
    assert.equal(skills[0].status, 'unavailable');
  });

  it('提供但为空的来源不产生占位', () => {
    const sources = fullSources();
    sources.skill = { list: () => [] };
    configureAll(sources);
    assert.equal(catalog.descriptorsForSource('skill', ACTOR).length, 0);
    assert.equal(catalog.listToolDescriptors(ACTOR).some((tool) => /_registry$/.test(tool.name)), false);
  });
});

describe('executableOnly 过滤', () => {
  it('只返回 enabled 且 executable 的工具', () => {
    configureAll();
    const all = catalog.toolCatalogSnapshot({ actor: ACTOR });
    const ready = catalog.toolCatalogSnapshot({ actor: ACTOR, executableOnly: true });

    assert.ok(ready.descriptors.length > 0);
    assert.ok(ready.descriptors.length < all.descriptors.length);
    for (const descriptor of ready.descriptors) {
      assert.equal(descriptor.enabled, true, descriptor.name);
      assert.equal(descriptor.executable, true, descriptor.name);
    }
    assert.equal(ready.descriptors.some((descriptor) => descriptor.name === 'media_describe_image'), false);
    assert.equal(ready.descriptors.some((descriptor) => descriptor.name === 'skill__off'), false);
    assert.equal(ready.tools.length, ready.descriptors.length);
    assert.equal(ready.summary.pending, 0);
  });

  it('appId / sourceId 过滤叠加在 executableOnly 之上', () => {
    configureAll();
    const snap = catalog.toolCatalogSnapshot({ actor: ACTOR, executableOnly: true, appId: 'weather-pack' });
    assert.deepEqual(new Set(namesOf(snap.descriptors)), new Set(['wx_now', 'wx_skill']));
    const bySource = catalog.toolCatalogSnapshot({ actor: ACTOR, executableOnly: true, source: 'mcp', sourceId: 'fs server' });
    assert.deepEqual(namesOf(bySource.descriptors), ['mcp__fs_server__read_file']);
  });
});

describe('同名冲突', () => {
  it('同名工具保留首次声明', () => {
    const sources = fullSources();
    sources.system.list = () => [{
      toolName: 'open_app', skillId: 'shadow',
      definition: { name: '影子打开', description: '与内置工具同名', enabled: true, kind: 'image_generate', inputSchema: { type: 'object' } },
    }];
    configureAll(sources);

    const descriptors = catalog.listToolDescriptors(ACTOR);
    const open = descriptors.filter((descriptor) => descriptor.name === 'open_app');
    assert.equal(open.length, 1);
    assert.equal(open[0].sourceId, 'desktop');
    assert.equal(open[0].statusText, '客户端可执行');
  });

  it('来源内部同名去重且函数工具名唯一', () => {
    const sources = fullSources();
    sources.file = {
      list: () => [
        { name: 'fs_list', description: '第一份', mutates: false, parameters: { type: 'object' } },
        { name: 'fs_list', description: '第二份', mutates: false, parameters: { type: 'object' } },
      ],
    };
    configureAll(sources);

    assert.equal(catalog.descriptorsForSource('file').length, 1);
    const snap = catalog.toolCatalogSnapshot();
    const toolNames = snap.tools.map((tool) => tool.function.name);
    assert.equal(new Set(toolNames).size, toolNames.length);
    assert.equal(snap.descriptors.filter((descriptor) => descriptor.name.startsWith('mcp__')).length, 1);
    assert.equal(new Set(namesOf(snap.descriptors)).size, snap.descriptors.length);
  });
});

describe('descriptor 完整性', () => {
  it('所有 descriptor 与 function tool 字段完整', () => {
    configureAll();
    const snap = catalog.toolCatalogSnapshot({ actor: ACTOR });
    const validSources = new Set(['system', 'file', 'app', 'mcp', 'skill']);
    const validStatuses = new Set(['ready', 'pending', 'disabled', 'unavailable']);
    const validRisks = new Set(['read', 'write', 'delete', 'external', 'system']);

    assert.ok(snap.descriptors.length > 0);
    for (const descriptor of snap.descriptors) {
      assert.equal(typeof descriptor.name, 'string');
      assert.ok(descriptor.name.length > 0);
      assert.equal(typeof descriptor.title, 'string');
      assert.equal(typeof descriptor.description, 'string');
      assert.ok(validSources.has(descriptor.source), `非法来源 ${descriptor.source}`);
      assert.equal(typeof descriptor.sourceId, 'string');
      assert.equal(typeof descriptor.enabled, 'boolean');
      assert.equal(typeof descriptor.executable, 'boolean');
      assert.ok(validStatuses.has(descriptor.status), `非法状态 ${descriptor.status}`);
      assert.equal(typeof descriptor.statusText, 'string');
      assert.equal(typeof descriptor.inputSchema, 'object');
      assert.notEqual(descriptor.inputSchema, null);
      assert.ok(Array.isArray(descriptor.permissions));
      assert.ok(validRisks.has(descriptor.risk), `非法风险级别 ${descriptor.risk}`);
      assert.ok(Array.isArray(descriptor.sideEffects));
      assert.ok(Array.isArray(descriptor.whenToUse));
      assert.equal(typeof descriptor.handler, 'object');
      assert.equal(typeof descriptor.handler.type, 'string');
    }

    for (const tool of snap.tools) {
      assert.equal(tool.type, 'function');
      assert.equal(typeof tool.function.name, 'string');
      assert.match(tool.function.description, /^\[.+]\s/);
      assert.equal(typeof tool.function.parameters, 'object');
      assert.equal(tool.x_dx_capability.schema, 'dx-agent-capability/v1');
      assert.equal(typeof tool.x_dx_capability.id, 'string');
      assert.equal(typeof tool.x_dx_capability.domain, 'string');
    }
  });
});

describe('summary 计数', () => {
  it('total/ready/pending 与来源分布一致', () => {
    configureAll();
    const snap = catalog.toolCatalogSnapshot({ actor: ACTOR });
    assert.equal(snap.summary.total, snap.descriptors.length);
    assert.equal(snap.summary.ready, snap.descriptors.filter((descriptor) => descriptor.status === 'ready').length);
    assert.equal(snap.summary.pending, snap.descriptors.filter((descriptor) => descriptor.status === 'pending').length);
    assert.deepEqual(Object.keys(snap.summary.sources).sort(), ['app', 'file', 'mcp', 'skill', 'system']);
    const sum = Object.values(snap.summary.sources).reduce((total, count) => total + count, 0);
    assert.equal(sum, snap.summary.total);
    assert.ok(snap.summary.ready > 0);
  });
});

describe('runCatalogTool', () => {
  it('命中系统能力并透传执行上下文', async () => {
    configureAll();
    const result = await catalog.runCatalogTool('media_generate_image', { prompt: '一只猫', __model: 'm1' }, ACTOR);
    assert.equal(result.skillId, 'skill-image');
    assert.equal(result.args.prompt, '一只猫');
    assert.equal(result.ctx.userId, 'u1');
    assert.equal(result.ctx.model, 'm1');
  });

  it('命中 APP 天气工具并注入天气数据', async () => {
    configureAll();
    const weather = await catalog.runCatalogTool('wx_now', { city: '北京' }, ACTOR);
    assert.equal(weather.weather.city, '北京');
    assert.match(weather.text, /北京当前晴/);

    const skillHit = await catalog.runCatalogTool('wx_skill', { instruction: '今天天气怎么样', city: '北京' }, ACTOR);
    assert.equal(skillHit.skillId, 'skill-weather');
    assert.match(skillHit.args.instruction, /天气数据/);
    assert.match(skillHit.args.instruction, /北京/);
  });

  it('未命中抛出未知工具', async () => {
    configureAll();
    await assert.rejects(catalog.runCatalogTool('not_a_tool', {}, ACTOR), /未知工具：not_a_tool/);
    await assert.rejects(catalog.runCatalogTool('wx_now', {}, ACTOR, { sourceId: 'other-pack' }), /未知工具：wx_now/);
  });

  it('权限拒绝与未登录', async () => {
    configureAll();
    await assert.rejects(catalog.runCatalogTool('wx_now', { city: '北京' }, { id: 'u2', permissions: [] }), /没有打开此 APP 的权限/);
    await assert.rejects(catalog.runCatalogTool('media_generate_image', {}), /请先登录/);
  });

  it('客户端工具不能通过服务端运行', async () => {
    configureAll();
    await assert.rejects(catalog.runCatalogTool('open_app', { app: 'music' }, ACTOR), /桌面客户端执行/);
  });
});
