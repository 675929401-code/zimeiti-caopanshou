import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, execute } from '@/lib/voice-studio/db';
import { withAdminAuth } from '@/lib/api-middleware';

const columns = 'id, name, modelId, resourceId, totalPrice, totalChars, costPrice, unit, profitMargin, isActive, sort, createdAt, updatedAt';
class ModelInputError extends Error {}
async function readBody(request: Request) {
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ModelInputError('请求格式无效');
  return body as Record<string, unknown>;
}
function rejectSecret(body: Record<string, unknown>) {
  return Object.hasOwn(body, 'apiKey') ? NextResponse.json({ success: false, code: 'VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY', message: '供应商密钥由主站统一配置中心管理，本接口不接收或回传密钥' }, { status: 400 }) : null;
}
function modelInput(body: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = { resourceId: '', totalPrice: 28, totalChars: 100000, unit: '千字符', profitMargin: 100, isActive: false, sort: 0, ...previous, ...body };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const resourceId = typeof value.resourceId === 'string' ? value.resourceId.trim() || modelId : '';
  if (!name || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(modelId) || !resourceId || resourceId.length > 160) throw new ModelInputError('请填写有效的模型名称、模型ID和资源ID');
  const number = (input: unknown) => typeof input === 'number' ? input : typeof input === 'string' && input.trim() ? Number(input) : NaN;
  const totalPrice = number(value.totalPrice), totalChars = number(value.totalChars), profitMargin = number(value.profitMargin), sort = number(value.sort);
  if (!Number.isFinite(totalPrice) || totalPrice <= 0 || !Number.isSafeInteger(totalChars) || totalChars <= 0) throw new ModelInputError('语音套餐价格和计费数量必须大于0，计费数量必须是整数');
  if (!Number.isFinite(profitMargin) || profitMargin < 0 || profitMargin > 10000) throw new ModelInputError('加价率必须在0%到10000%之间');
  if (!Number.isSafeInteger(sort) || Math.abs(sort) > 100000) throw new ModelInputError('排序数值无效');
  if (!['千字符', '分钟', '次'].includes(String(value.unit))) throw new ModelInputError('计费单位请选择千字符、分钟或次');
  if (![true, false, 0, 1].includes(value.isActive as boolean)) throw new ModelInputError('模型启用状态无效');
  const costPrice = totalPrice / totalChars * (value.unit === '千字符' ? 1000 : 1);
  if (!Number.isFinite(costPrice) || costPrice <= 0) throw new ModelInputError('模型成本无效');
  return { name, modelId, resourceId, totalPrice, totalChars, costPrice, unit: value.unit, profitMargin, isActive: value.isActive === true || value.isActive === 1 ? 1 : 0, sort };
}
function failure(error: unknown, action: string) {
  if (error instanceof ModelInputError || error instanceof SyntaxError) return NextResponse.json({ success: false, message: error instanceof ModelInputError ? error.message : '请求格式无效' }, { status: 400 });
  if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
  console.error('[voice-studio models]', action, error);
  return NextResponse.json({ success: false, message: action + '失败' }, { status: 500 });
}
export async function GET(request: Request) {
  return withAdminAuth(request, async () => {
    try { return NextResponse.json({ success: true, data: queryAll(`SELECT ${columns} FROM ModelConfig ORDER BY sort ASC, createdAt ASC`) }); }
    catch (error) { return failure(error, '获取模型配置'); }
  });
}
export async function POST(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const body = await readBody(request), rejected = rejectSecret(body); if (rejected) return rejected;
      const value = modelInput(body);
      if (queryOne('SELECT id FROM ModelConfig WHERE modelId = ?', [value.modelId])) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
      const id = randomUUID(), now = Date.now();
      execute('INSERT INTO ModelConfig (id,name,modelId,resourceId,totalPrice,totalChars,costPrice,unit,profitMargin,isActive,sort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id,value.name,value.modelId,value.resourceId,value.totalPrice,value.totalChars,value.costPrice,value.unit,value.profitMargin,value.isActive,value.sort,now,now]);
      return NextResponse.json({ success: true, data: { id, name: value.name, modelId: value.modelId }, message: '模型添加成功' });
    } catch (error) { return failure(error, '添加模型'); }
  });
}
export async function PUT(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const body = await readBody(request), rejected = rejectSecret(body); if (rejected) return rejected;
      if (typeof body.id !== 'string' || !body.id.trim()) throw new ModelInputError('缺少模型ID');
      const previous = queryOne<Record<string, unknown>>(`SELECT ${columns} FROM ModelConfig WHERE id = ?`, [body.id]);
      if (!previous) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      const value = modelInput(body, previous);
      if (queryOne('SELECT id FROM ModelConfig WHERE modelId = ? AND id <> ?', [value.modelId, body.id])) return NextResponse.json({ success: false, message: '模型ID已存在' }, { status: 409 });
      const changed = execute('UPDATE ModelConfig SET name=?,modelId=?,resourceId=?,totalPrice=?,totalChars=?,costPrice=?,unit=?,profitMargin=?,isActive=?,sort=?,updatedAt=? WHERE id=?', [value.name,value.modelId,value.resourceId,value.totalPrice,value.totalChars,value.costPrice,value.unit,value.profitMargin,value.isActive,value.sort,Date.now(),body.id]);
      if (!changed.changes) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      return NextResponse.json({ success: true, message: '模型更新成功' });
    } catch (error) { return failure(error, '更新模型'); }
  });
}
export async function DELETE(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const id = new URL(request.url).searchParams.get('id'); if (!id) throw new ModelInputError('缺少模型ID');
      const changed = execute('DELETE FROM ModelConfig WHERE id = ?', [id]);
      if (!changed.changes) return NextResponse.json({ success: false, message: '模型不存在' }, { status: 404 });
      return NextResponse.json({ success: true, message: '模型删除成功' });
    } catch (error) { return failure(error, '删除模型'); }
  });
}
