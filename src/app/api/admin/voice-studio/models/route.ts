import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, execute } from '@/lib/voice-studio/db';
import { withAdminAuth } from '@/lib/api-middleware';
import { normalizeVoiceModelInput, VoiceModelInputError, voicePricingService, voicePricingSupport } from '@/lib/vs/model-config';

const columns = 'id, name, modelId, resourceId, totalPrice, totalChars, costPrice, unit, profitMargin, isActive, sort, createdAt, updatedAt';
async function readBody(request: Request) {
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VoiceModelInputError('请求格式无效');
  return body as Record<string, unknown>;
}
function rejectSecret(body: Record<string, unknown>) {
  return Object.hasOwn(body, 'apiKey') ? NextResponse.json({ success: false, code: 'VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY', message: '供应商密钥由主站统一配置中心管理，本接口不接收或回传密钥' }, { status: 400 }) : null;
}
function rowId(request: Request, bodyId?: unknown) {
  const url = new URL(request.url);
  const pathId = url.pathname.match(/^\/api\/admin\/voice-studio\/models\/([^/]+)\/?$/u)?.[1];
  if (bodyId !== undefined && (typeof bodyId !== 'string' || !bodyId.trim())) throw new VoiceModelInputError('缺少模型ID');
  const candidates = [pathId ? decodeURIComponent(pathId) : '', url.searchParams.get('id') || '', typeof bodyId === 'string' ? bodyId : ''].filter(Boolean);
  if (!candidates.length) throw new VoiceModelInputError('缺少模型ID');
  if (new Set(candidates).size !== 1) throw new VoiceModelInputError('请求路径与模型ID不一致');
  return candidates[0];
}
function failure(error: unknown, action: string) {
  if (error instanceof VoiceModelInputError || error instanceof SyntaxError) return NextResponse.json({ success: false, code: error instanceof VoiceModelInputError ? error.code : 'VOICE_MODEL_INPUT_INVALID', message: error instanceof VoiceModelInputError ? error.message : '请求格式无效' }, { status: 400 });
  if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
  console.error('[voice-studio models]', action, error);
  return NextResponse.json({ success: false, message: action + '失败' }, { status: 500 });
}
export async function GET(request: Request) {
  return withAdminAuth(request, async () => {
    try { return NextResponse.json({ success: true, data: queryAll<Record<string, unknown>>(`SELECT ${columns} FROM ModelConfig ORDER BY sort ASC, createdAt ASC`).map(row => {
      const service = voicePricingService(String(row.modelId || ''));
      return { ...row, runtimeSupported: Boolean(service), supportStatus: voicePricingSupport(String(row.modelId || '')).status, serviceDescription: voicePricingSupport(String(row.modelId || '')).description };
    }) }); }
    catch (error) { return failure(error, '获取模型配置'); }
  });
}
export async function POST(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const body = await readBody(request), rejected = rejectSecret(body); if (rejected) return rejected;
      const value = normalizeVoiceModelInput(body);
      if (queryOne('SELECT id FROM ModelConfig WHERE modelId = ?', [value.modelId])) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
      const id = randomUUID(), now = Date.now();
      execute('INSERT INTO ModelConfig (id,name,modelId,resourceId,totalPrice,totalChars,costPrice,unit,profitMargin,isActive,sort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id,value.name,value.modelId,value.resourceId,value.totalPrice,value.totalChars,value.costPrice,value.unit,value.profitMargin,value.isActive,value.sort,now,now]);
      return NextResponse.json({ success: true, data: { id, name: value.name, modelId: value.modelId }, message: '计价服务添加成功；实际使用仍需供应商、音色和账户授权就绪' });
    } catch (error) { return failure(error, '添加模型'); }
  });
}
export async function PUT(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const body = await readBody(request), rejected = rejectSecret(body); if (rejected) return rejected;
      const id = rowId(request, body.id);
      const previous = queryOne<Record<string, unknown>>(`SELECT ${columns} FROM ModelConfig WHERE id = ?`, [id]);
      if (!previous) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      // Stopping a legacy service must remain possible even if its old pricing is invalid.
      if ((body.isActive === false || body.isActive === 0) && Object.keys(body).every(key => key === 'id' || key === 'isActive')) {
        const stopped = execute('UPDATE ModelConfig SET isActive=0,updatedAt=? WHERE id=?', [Date.now(), id]);
        return NextResponse.json({ success: Boolean(stopped.changes), message: stopped.changes ? '计价服务已停用' : '模型不存在' }, { status: stopped.changes ? 200 : 404 });
      }
      const value = normalizeVoiceModelInput(body, previous);
      if (queryOne('SELECT id FROM ModelConfig WHERE modelId = ? AND id <> ?', [value.modelId, id])) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
      const changed = execute('UPDATE ModelConfig SET name=?,modelId=?,resourceId=?,totalPrice=?,totalChars=?,costPrice=?,unit=?,profitMargin=?,isActive=?,sort=?,updatedAt=? WHERE id=?', [value.name,value.modelId,value.resourceId,value.totalPrice,value.totalChars,value.costPrice,value.unit,value.profitMargin,value.isActive,value.sort,Date.now(),id]);
      if (!changed.changes) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      return NextResponse.json({ success: true, message: '模型更新成功' });
    } catch (error) { return failure(error, '更新模型'); }
  });
}
export async function DELETE(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const id = rowId(request);
      const changed = execute('DELETE FROM ModelConfig WHERE id = ?', [id]);
      if (!changed.changes) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      return NextResponse.json({ success: true, message: '模型删除成功' });
    } catch (error) { return failure(error, '删除模型'); }
  });
}
