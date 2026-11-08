export const EXTRACTOR_VERSION = 'jiyi-review-v1';

export function textOf(message) {
  return (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
export function eligibleSession(header) {
  return header?.origin !== 'subagent' && !(header?.delegationDepth > 0);
}
export function userSource(event, sessionId) {
  if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return null;
  const quote = textOf(event.data);
  if (!quote) return null;
  return { sessionId, eventId: String(event.seq), eventSeq: event.seq, eventTime: event.time, quote };
}
function isTaskDescription(text) {
  if (/(?:^|\n)\s*(?:任务|需求(?:说明|描述|文档)?|执行说明|Task|Requirements)\s*[:：]/iu.test(text)) return true;
  const current=/(?:^|\n)\s*(?:现状|当前问题)\s*[:：]|【现状】/u.test(text);
  const goal=/(?:^|\n)\s*目标\s*[:：]|【目标】/u.test(text);
  const sections=/(?:^|\n)\s*【[^】]+】/u.test(text);
  const directive=/^\s*(?:请|帮我|需要你)/u.test(text);
  const constraints=/(?:【(?:验收|约束)[^】]*】|(?:^|\n)\s*(?:验收|约束)\s*[:：])/u.test(text);
  return goal && (current || constraints) && (sections || directive || text.length>=400);
}
function isDirectiveRelay(text) {
  const trimmed=text.trim();
  if(!trimmed) return false;
  if(/^(?:卡点|报错|阻塞(?:点)?|blocked)\s*[:：]/iu.test(trimmed)) return true;
  if(/^(?:请)?解决(?:一下|这个问题)/u.test(trimmed)) return true;
  return false;
}
function ignoreStatusSource(text) {
  return isTaskDescription(text) || isDirectiveRelay(text);
}
export function parseExtraction(text, payload, existing = []) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (cause) { throw Object.assign(new Error('抽取模型没有返回有效 JSON', { cause }), { code: 'EXTRACTION_JSON' }); }
  if (!parsed || !Array.isArray(parsed.memories) || parsed.memories.length > 12) throw Object.assign(new Error('抽取结果 schema 无效或超过 12 条'), { code: 'EXTRACTION_SCHEMA' });
  const types = new Set(['preference', 'project_fact', 'decision', 'experience', 'status', 'lesson']);
  // Classify complete user messages, not the model's shorter selected quotes.
  const ignoredStatusSeqs=new Set(payload.sources.filter(s=>ignoreStatusSource(s.quote)).map(s=>s.eventSeq));
  return parsed.memories.map((m) => {
    if (!m || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 1500 || !types.has(m.type) || !['global', 'project'].includes(m.scope) || typeof m.factKey !== 'string' || !m.factKey.trim() || m.factKey.length > 180 || !Array.isArray(m.sourceSeqs) || !m.sourceSeqs.length || !Array.isArray(m.quotes) || m.quotes.length !== m.sourceSeqs.length) throw Object.assign(new Error('抽取记忆缺少有效内容/类型/范围/来源'), { code: 'EXTRACTION_SCHEMA' });
    let sources = m.sourceSeqs.map((seq, i) => {
      const source = payload.sources.find(s => s.eventSeq === seq);
      const quote = m.quotes[i];
      if (!source || typeof quote !== 'string' || quote.trim().length < 2 || !source.quote.includes(quote)) throw Object.assign(new Error('抽取记忆的引用不是本批来源原文'), { code: 'EXTRACTION_EVIDENCE' });
      return { ...source, quote, evidence: source.evidence ?? 'user-explicit' };
    });
    if (m.scope === 'project' && !payload.projectId) throw Object.assign(new Error('项目记忆缺少稳定项目标识'), { code: 'EXTRACTION_SCOPE' });
    if (m.projectName && m.scope === 'project' && !payload.projectNames?.includes(m.projectName)) throw Object.assign(new Error('抽取结果指向非当前且未消歧项目'), { code: 'EXTRACTION_SCOPE' });
    let supersedes = m.supersedes ?? [];
    const inScope=e=>e.scope===m.scope && (m.scope==='global' || e.projectId===payload.projectId);
    if (!Array.isArray(supersedes) || supersedes.some(id => !existing.some(e => e.id === id && inScope(e)))) throw Object.assign(new Error('抽取替代关系越界或引用不存在'), { code: 'EXTRACTION_SCOPE' });
    let factKey=m.factKey.trim();
    if(m.type==='status') {
      sources=sources.filter(s=>!ignoredStatusSeqs.has(s.eventSeq));
      if(!sources.length) return null;
      const normalized=value=>value?.normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
      const previous=existing.filter(e=>inScope(e) && (e.kind??e.type)==='status' && (supersedes.includes(e.id)||normalized(e.factKey)===normalized(factKey)));
      const keys=[...new Set(previous.map(e=>e.factKey).filter(Boolean))];
      if(keys.length>1) throw Object.assign(new Error('一个新状态不能合并多个不同事项的旧状态'),{code:'EXTRACTION_SCOPE'});
      if(keys.length) factKey=keys[0];
      supersedes=[...new Set([...supersedes,...previous.map(e=>e.id)])];
    }
    const confidence = m.confidence ?? (m.type === 'lesson' ? 0.8 : 1);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw Object.assign(new Error('抽取记忆 confidence 无效'), { code: 'EXTRACTION_SCHEMA' });
    return { content: m.content.trim(), type: m.type, scope: m.scope, projectId: m.scope === 'project' ? payload.projectId : null, factKey, confidence, supersedes, sources, extractionModel: payload.extractionModel, extractionVersion: m.extractionVersion ?? EXTRACTOR_VERSION };
  }).filter(Boolean);
}
