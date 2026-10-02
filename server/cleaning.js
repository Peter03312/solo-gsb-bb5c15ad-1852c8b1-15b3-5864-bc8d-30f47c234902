'use strict';
// CLEAN 事件清洗范围（部分清洗）的统一解析，供单条事件写入（server.js）
// 与整组换线预演/确认（replan.js）共用，保证两处校验与规范化完全一致。
//
//   省略字段或 null = 全清（旧 CLEAN 事件与旧请求的既有语义），返回 { scope:null, json:null }；
//   数组         = 部分清洗：本次仅清除指定过敏原的设备残留及其来源，
//                  其余残留继续进入后续批次；规范化为去空白、去重、稳定排序后的数组。
//
// 拒绝规则：非数组（且非缺省/null）、显式空集、元素不是字符串、元素为空白字符串。
// 重复名称按一个处理。

function normalizeCleanScope(raw, where = 'clean_allergens') {
  if (raw === undefined || raw === null) return { scope: null, json: null };
  if (!Array.isArray(raw)) {
    throw new Error(`${where} 必须是过敏原名称数组；省略该字段表示全清`);
  }
  if (raw.length === 0) {
    throw new Error(`${where} 不能是显式空集：全清请省略 ${where} 字段（或传 null）`);
  }
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string' || !raw[i].trim()) {
      throw new Error(
        `${where}[${i}] 不合法：过敏原名称必须是非空白字符串；重复名称按一个处理`
      );
    }
  }
  const scope = [...new Set(raw.map((a) => a.trim()))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  return { scope, json: JSON.stringify(scope) };
}

module.exports = { normalizeCleanScope };
