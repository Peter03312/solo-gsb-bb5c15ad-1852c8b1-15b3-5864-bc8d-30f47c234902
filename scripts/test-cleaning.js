'use strict';
// 部分清洗（清洗范围）端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   清洗范围校验：省略=全清；显式空集/非字符串/空白名称拒绝；重复名称按一个处理；
//   部分清洗推导：仅清除指定过敏原的设备残留及来源，其余残留继续进入后续批次；
//   更正/删除早期清洗事件后沿时间线重算，并联动放行失效、标签卷停用、出货单待评估、处置结论需重评；
//   批号追溯：部分清洗按来源过敏原保留设备传播（覆盖全部才截断；未全部覆盖保留；
//             来源无登记过敏原时不得据此排除；只有全清截断）；不抹去直接投料与批次引用；
//   整组换线：update/insert_clean 支持 clean_allergens；预演不改正式状态；非法范围预演拒绝；
//   /api/state：事件清洗范围/清洗后残留、设备最后部分清洗时间字段。
//   node scripts/test-cleaning.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39141';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    let s0 = (await api('GET', '/api/state')).json;
    const id = (code) => s0.materials.find((m) => m.code === code).id;
    const PEANUT = id('PEANUT-01'), SALT = id('SALT-01'),
      MILK = id('MILK-01'), EGG = id('EGG-01'), SESAME = id('SESAME-01');
    const MILK_C = s0.materials.find((m) => m.code === 'MILK-01').lots
      .find((l) => l.lot_code === 'SUP-MILK-20260924-C').id;
    const EGG_A = s0.materials.find((m) => m.code === 'EGG-01').lots
      .find((l) => l.lot_code === 'SUP-EGG-20260927-1').id;
    const LINEC = s0.equipment.find((q) => q.code === 'LINE-C').id;
    let r;

    // ---------- 1. 演示数据中的部分清洗展示字段 ----------
    console.log('1) 演示时间线：LINE-C 两次部分清洗 + 全清收尾');
    const pc17 = s0.events.find((e) => e.type === 'CLEAN' && e.event_time === '2026-09-30T17:00');
    check('17:00 为部分清洗，范围 [乳]',
      JSON.stringify(pc17.clean_allergens) === JSON.stringify(['乳']) && pc17.clean_full === false,
      pc17);
    check('17:00 清洗后残留仅蛋（附来源路径）',
      JSON.stringify(pc17.clean_residue_allergens) === JSON.stringify(['蛋']) &&
      pc17.clean_residue_paths['蛋'].length > 0, pc17);
    const pc20 = s0.events.find((e) => e.type === 'CLEAN' && e.event_time === '2026-09-30T20:00');
    check('20:00 省略范围 = 全清', pc20.clean_full === true && pc20.clean_allergens === null);
    const lineC = s0.equipment.find((q) => q.id === LINEC);
    check('设备残留为空且记录最后全清/最后部分清洗时间',
      lineC.allergens.length === 0 &&
      lineC.last_cleaned_at === '2026-09-30T20:00' &&
      lineC.last_partial_cleaned_at === '2026-09-30T19:00', lineC);
    const bPC2 = s0.batches.find((b) => b.code === 'BATCH-PC2');
    check('BATCH-PC2 推导为 蛋+芝麻（蛋由部分清洗未清除的残留带入）',
      JSON.stringify(bPC2.allergens) === JSON.stringify(['蛋', '芝麻']), bPC2.allergens);
    const bPC3 = s0.batches.find((b) => b.code === 'BATCH-PC3');
    check('BATCH-PC3 推导仅芝麻（两次部分清洗后乳/蛋残留均已清除）',
      JSON.stringify(bPC3.allergens) === JSON.stringify(['芝麻']), bPC3.allergens);

    // ---------- 2. 清洗范围请求校验 ----------
    console.log('2) 请求校验：显式空集/非字符串/空白/非数组拒绝；重复名去重；省略=全清');
    const E1 = (await api('POST', '/api/equipment', { code: 'EQ-T', name: '联动测试线' })).json.id;
    const E2 = (await api('POST', '/api/equipment', { code: 'EQ-U', name: '无过敏原原料测试线' })).json.id;
    const E3 = (await api('POST', '/api/equipment', { code: 'EQ-V', name: '引用不截断测试线' })).json.id;
    const E4 = (await api('POST', '/api/equipment', { code: 'EQ-R', name: '换线插入测试线' })).json.id;

    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:00', equipment_id: E1, clean_allergens: []
    });
    check('显式空集 → 400', r.status === 400, r.json);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:00', equipment_id: E1, clean_allergens: ['乳', 3]
    });
    check('非字符串名称 → 400', r.status === 400, r.json);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:00', equipment_id: E1, clean_allergens: ['   ']
    });
    check('空白名称 → 400', r.status === 400, r.json);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:00', equipment_id: E1, clean_allergens: '乳'
    });
    check('非数组 → 400', r.status === 400, r.json);

    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-03T21:00', equipment_id: LINEC,
      note: '重复名规范化', clean_allergens: ['乳', ' 乳 ', '蛋', '蛋 ']
    });
    check('重复/带空白名称按一个处理，创建成功', r.status === 200, r.json);
    s0 = (await api('GET', '/api/state')).json;
    const dupEv = s0.events.find((e) => e.note === '重复名规范化');
    check('存储规范化为 [蛋, 乳]',
      JSON.stringify(dupEv.clean_allergens) === JSON.stringify(['蛋', '乳']), dupEv.clean_allergens);
    // PUT 改为全清（省略范围）
    r = await api('PUT', `/api/events/${dupEv.id}`, {
      type: 'CLEAN', event_time: '2026-10-03T21:00', equipment_id: LINEC, note: '改为全清'
    });
    check('更正为全清成功', r.status === 200, r.json);
    s0 = (await api('GET', '/api/state')).json;
    const fullEv = s0.events.find((e) => e.id === dupEv.id);
    check('更正后 clean_full=true', fullEv.clean_full === true && fullEv.clean_allergens === null);

    // ---------- 3. 部分清洗 → 重算联动放行/标签卷/出货单/处置结论 ----------
    console.log('3) 中途插入部分清洗：后续批失去花生 → 放行失效/卷停用/出货待评估 → 删除清洗后处置需重评');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: E1,
      batch_code: 'BAT-TC1', note: '花生班',
      material_inputs: [{ material_id: PEANUT }]
    });
    check('BAT-TC1 创建', r.status === 200, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00', equipment_id: E1,
      batch_code: 'BAT-TC2', note: '空白班（吃花生残留）',
      material_inputs: [{ material_id: SALT }]
    });
    check('BAT-TC2 创建（初始含花生残留）', r.status === 200, r.json);
    s0 = (await api('GET', '/api/state')).json;
    const tc2 = s0.batches.find((b) => b.code === 'BAT-TC2');
    check('插入清洗前 BAT-TC2 含花生', tc2.allergens.includes('花生'), tc2.allergens);

    // 按当时结果登记放行 → 标签卷 → 核销 → 出货
    r = await api('POST', '/api/releases', {
      batch_id: tc2.id, released_at: '2026-10-02T09:30', released_by: '测试质检'
    });
    check('放行登记成功', r.status === 200, r.json);
    const releaseId = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: tc2.id, release_id: releaseId, allergens: ['花生'],
      print_qty: 100, registered_by: '测试包装'
    });
    check('标签卷登记成功', r.status === 200 && r.json.roll_code, r.json);
    const rollId = r.json.id;
    r = await api('POST', `/api/label-rolls/${rollId}/consume`, {
      expected_revision: 0, applied: 10, voided: 0, used_by: '测试包装'
    });
    check('核销贴用 10 张', r.status === 200 && r.json.revision === 1, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: tc2.id, ship_qty: 10, shipped_by: '测试仓管',
      allocations: [{ roll_id: rollId, qty: 10 }]
    });
    check('出货确认成功', r.status === 200 && r.json.status === 'SHIPPED', r.json);
    const shipCode = r.json.shipment_code;

    // 08:30 插入部分清洗（只清花生）：BAT-TC2 失去花生残留
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:30', equipment_id: E1,
      note: '中途核实只清花生', clean_allergens: ['花生']
    });
    check('部分清洗创建并重算', r.status === 200, r.json);
    check('响应附失效放行',
      r.json.invalidated.some((x) => x.id === releaseId), r.json.invalidated);
    check('响应附停用标签卷',
      r.json.retired_rolls.some((x) => x.id === rollId), r.json.retired_rolls);
    check('响应附待评估出货单',
      r.json.pending_shipments.some((x) => x.shipment_code === shipCode),
      r.json.pending_shipments.map((x) => x.shipment_code));
    s0 = (await api('GET', '/api/state')).json;
    const tc2b = s0.batches.find((b) => b.code === 'BAT-TC2');
    check('重算后 BAT-TC2 不再含花生', !tc2b.allergens.includes('花生'), tc2b.allergens);
    const tc1 = s0.batches.find((b) => b.code === 'BAT-TC1');
    check('BAT-TC1 直接投料不受影响（仍含花生）', tc1.allergens.includes('花生'), tc1.allergens);
    const cleanMid = s0.events.find((e) => e.note === '中途核实只清花生');
    check('部分清洗事件清洗后残留为空（当时残留仅花生）',
      cleanMid.clean_residue_allergens.length === 0, cleanMid.clean_residue_allergens);

    // 登记召回处置，再删除该清洗 → 结论应变 STALE
    let eval0 = (await api('GET', `/api/shipments/${shipCode}/evaluation`)).json;
    r = await api('POST', `/api/shipments/${shipCode}/dispositions`, {
      decision: 'RECALL', decided_by: '测试质检', basis: '花生残留批次整批召回演练',
      version: eval0.version
    });
    check('召回处置登记成功', r.status === 200 && r.json.disposition.life_status === 'ACTIVE', r.json);
    const dispositionId = r.json.disposition.id;
    r = await api('DELETE', `/api/events/${cleanMid.id}`);
    check('删除部分清洗事件成功并重算', r.status === 200, r.json);
    check('删除后 BAT-TC2 恢复花生残留',
      (await api('GET', '/api/state')).json.batches.find((b) => b.code === 'BAT-TC2')
        .allergens.includes('花生'));
    check('旧召回结论被标需重新评估（只增不改、不自动生效）',
      r.json.stale_dispositions.some((x) => x.disposition_id === dispositionId),
      r.json.stale_dispositions);

    // ---------- 4. 追溯：部分清洗按来源过敏原保留设备传播 ----------
    console.log('4) 追溯：部分清洗的设备传播规则（含已知批号与批号未知）');
    const trace = async (params) =>
      api('GET', '/api/trace/material-lot?' + new URLSearchParams(params).toString());
    const codes = (list) => (list || []).map((x) => x.batch_code);

    // 4.1 演示线：MILK-C 已知批号，17:00 部分清洗 [乳] 覆盖牛奶全部过敏原 → 设备传播截断
    r = await trace({ material_id: MILK, lot_id: MILK_C });
    check('MILK-C 确定命中仅 BATCH-PC1（部分清洗覆盖乳后截断）',
      JSON.stringify(codes(r.json.confirmed_batches)) === JSON.stringify(['BATCH-PC1']),
      codes(r.json.confirmed_batches));
    // 4.2 EGG-A：17:00 未清蛋 → PC2 经设备残留命中（链含未截断依据）；19:00 清蛋后 PC3 不命中
    r = await trace({ material_id: EGG, lot_id: EGG_A });
    check('EGG-A 命中 PC1/PC2 但不命中 PC3',
      JSON.stringify(codes(r.json.confirmed_batches)) === JSON.stringify(['BATCH-PC1', 'BATCH-PC2']),
      codes(r.json.confirmed_batches));
    const eggPC2 = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-PC2');
    check('PC2 经设备残留进入且依据链标注“部分清洗未截断”',
      eggPC2.evidence.confirmed.routes.equipment_residue &&
      eggPC2.evidence.confirmed.chains.some((c) => c.includes('部分清洗未截断')),
      eggPC2.evidence.confirmed);
    check('PC1 的直接投料不被后续清洗抹去',
      r.json.confirmed_batches.some((b) => b.batch_code === 'BATCH-PC1' &&
        b.evidence.confirmed.routes.direct));

    // 4.3 来源原料无登记过敏原（盐）：部分清洗不能排除批号未知，只有全清截断
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: E2,
      batch_code: 'BAT-U1', material_inputs: [{ material_id: SALT }]
    });
    check('U1 创建', r.status === 200);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:30', equipment_id: E2,
      note: '清乳（与盐无关）', clean_allergens: ['乳']
    });
    check('U 线部分清洗创建', r.status === 200);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00', equipment_id: E2,
      batch_code: 'BAT-U2', material_inputs: []
    });
    check('U2 创建（无直接投料）', r.status === 200);
    r = await trace({ material_id: SALT });
    check('盐批号未知：部分清洗不能排除 → U2 仍无法排除（经设备残留）',
      codes(r.json.unresolved_batches).includes('BAT-U2'), codes(r.json.unresolved_batches));
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T09:30', equipment_id: E2, note: '全清截断'
    });
    check('U 线全清创建', r.status === 200);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T10:00', equipment_id: E2,
      batch_code: 'BAT-U3', material_inputs: [{ material_id: PEANUT }]
    });
    check('U3 创建（投花生）', r.status === 200);
    r = await trace({ material_id: SALT });
    check('全清后 U3 不再携带盐未知批号（设备传播截断；U3 直接投的是花生）',
      !codes(r.json.unresolved_batches).includes('BAT-U3'), codes(r.json.unresolved_batches));

    // 4.4 清洗不截断前序批次引用：V1 牛奶后部分清洗 [乳]，V2 引用 V1 仍确定命中
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: E3,
      batch_code: 'BAT-V1', material_inputs: [{ material_id: MILK, lot_id: MILK_C }]
    });
    check('V1 创建', r.status === 200);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:30', equipment_id: E3,
      note: '清乳（设备残留截断）', clean_allergens: ['乳']
    });
    check('V 线部分清洗创建', r.status === 200);
    s0 = (await api('GET', '/api/state')).json;
    const v1id = s0.batches.find((b) => b.code === 'BAT-V1').id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00', equipment_id: E3,
      batch_code: 'BAT-V2', material_inputs: [{ material_id: SALT }],
      ref_batch_ids: [v1id]
    });
    check('V2 创建（引用 V1）', r.status === 200);
    r = await trace({ material_id: MILK, lot_id: MILK_C });
    check('部分清洗后 V2 仍经“批次引用”确定命中（清洗不抹去批次引用）',
      codes(r.json.confirmed_batches).includes('BAT-V2'), codes(r.json.confirmed_batches));
    const v2 = r.json.confirmed_batches.find((x) => x.batch_code === 'BAT-V2');
    check('V2 该路径最后一跳为批次引用而非设备残留',
      v2.evidence.confirmed.routes.batch_reference, v2.evidence.confirmed.routes);

    // ---------- 5. 整组换线预演/确认支持清洗范围 ----------
    console.log('5) replan preview/apply：update 与 insert_clean 的清洗范围');
    s0 = (await api('GET', '/api/state')).json;
    const clean17 = s0.events.find((e) => e.type === 'CLEAN' &&
      e.event_time === '2026-09-30T17:00' && e.equipment_id === LINEC);
    const changes = [{
      op: 'update', event_id: clean17.id, type: 'CLEAN',
      event_time: '2026-09-30T17:00', equipment_id: LINEC,
      note: clean17.note, clean_allergens: ['乳', '蛋']
    }];
    r = await api('POST', '/api/replan/preview', { changes });
    check('预演 200 且回显清洗范围（规范化排序）',
      r.status === 200 &&
      JSON.stringify(r.json.changes[0].clean_allergens) === JSON.stringify(['蛋', '乳']), r.json);
    const pc2Diff = r.json.diff.batches.find((b) => b.code === 'BATCH-PC2');
    check('预演差异：BATCH-PC2 将移除蛋',
      pc2Diff && pc2Diff.removed.includes('蛋'), pc2Diff);
    // 预演不改正式状态
    s0 = (await api('GET', '/api/state')).json;
    check('预演后正式 BATCH-PC2 仍含蛋',
      s0.batches.find((b) => b.code === 'BATCH-PC2').allergens.includes('蛋'));
    // 非法范围预演即拒绝
    r = await api('POST', '/api/replan/preview', {
      changes: [{ ...changes[0], clean_allergens: [] }]
    });
    check('显式空集预演 → 400 INVALID_REQUEST',
      r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/replan/preview', {
      changes: [{ ...changes[0], clean_allergens: ['蛋', 5] }]
    });
    check('非字符串范围预演 → 400 INVALID_REQUEST',
      r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);

    // insert_clean 部分清洗并确认应用
    const insertChanges = [{
      op: 'insert_clean', client_key: 'rk1',
      event_time: '2026-10-02T07:30', equipment_id: E4,
      clean_allergens: ['花生'], note: '换线预演插入的部分清洗'
    }];
    const pv = await api('POST', '/api/replan/preview', { changes: insertChanges });
    check('插入部分清洗预演 200', pv.status === 200, pv.json);
    r = await api('POST', '/api/replan/apply', {
      version: pv.json.version, changes: insertChanges
    });
    check('确认应用 200', r.status === 200, r.json);
    check('返回新清洗事件 id',
      Number.isInteger(r.json.inserted_clean_events[0].event_id));
    s0 = (await api('GET', '/api/state')).json;
    const inserted = s0.events.find((e) => e.note === '换线预演插入的部分清洗');
    check('正式时间线存在该部分清洗且范围正确',
      inserted && JSON.stringify(inserted.clean_allergens) === JSON.stringify(['花生']) &&
      inserted.clean_full === false, inserted);
    const eqR = s0.equipment.find((q) => q.id === E4);
    check('无任何加工的设备：最后部分清洗时间已更新、残留仍为空',
      eqR.last_partial_cleaned_at === '2026-10-02T07:30' && eqR.allergens.length === 0, eqR);

    // ---------- 6. 既有 CLEAN 请求约定保持可用 ----------
    console.log('6) 旧请求（不带 clean_allergens）仍为全清');
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-04T08:00', equipment_id: E4, note: '旧式全清请求'
    });
    check('旧形态 CLEAN 创建成功', r.status === 200, r.json);
    s0 = (await api('GET', '/api/state')).json;
    const legacy = s0.events.find((e) => e.note === '旧式全清请求');
    check('旧形态 CLEAN 为全清且清洗后残留为空',
      legacy.clean_full === true && legacy.clean_residue_allergens.length === 0);

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
