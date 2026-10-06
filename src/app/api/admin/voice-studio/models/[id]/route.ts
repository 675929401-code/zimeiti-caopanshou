import { NextRequest, NextResponse } from 'next/server';
import { getVoiceDb } from '@/lib/voice-studio/db';
import { withAdminAuth } from '@/lib/api-middleware';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求处理失败';
}

// PUT 更新模型配置
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdminAuth(request, async () => {
  try {
    const { id } = await params;
    const body = await request.json();
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      return NextResponse.json(
        {
          success: false,
          code: 'VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY',
          message: '供应商密钥由主站统一配置中心管理，本接口不接收密钥',
        },
        { status: 400 },
      );
    }
    const db = getVoiceDb();

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name); }
    if (body.costPrice !== undefined) { fields.push('costPrice = ?'); values.push(body.costPrice); }
    if (body.profitMargin !== undefined) { fields.push('profitMargin = ?'); values.push(body.profitMargin); }
    if (body.totalPrice !== undefined) { fields.push('totalPrice = ?'); values.push(body.totalPrice); }
    if (body.totalChars !== undefined) { fields.push('totalChars = ?'); values.push(body.totalChars); }
    if (body.unit !== undefined) { fields.push('unit = ?'); values.push(body.unit); }
    if (body.isActive !== undefined) { fields.push('isActive = ?'); values.push(body.isActive ? 1 : 0); }
    if (body.resourceId !== undefined) { fields.push('resourceId = ?'); values.push(body.resourceId); }

    if (fields.length === 0) {
      return NextResponse.json({ success: false, message: '没有更新字段' }, { status: 400 });
    }

    fields.push('updatedAt = ?');
    values.push(Date.now());
    values.push(id);

    db.prepare(`UPDATE ModelConfig SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return NextResponse.json({ success: true, message: '更新成功' });
  } catch (error: unknown) {
    return NextResponse.json({ success: false, message: getErrorMessage(error) }, { status: 500 });
  }
  });
}

// DELETE 删除模型配置
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdminAuth(request, async () => {
  try {
    const { id } = await params;
    const db = getVoiceDb();
    db.prepare('DELETE FROM ModelConfig WHERE id = ?').run(id);
    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (error: unknown) {
    return NextResponse.json({ success: false, message: getErrorMessage(error) }, { status: 500 });
  }
  });
}
