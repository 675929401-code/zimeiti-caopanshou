import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api-middleware';

function managedExternallyResponse() {
  return NextResponse.json(
    {
      success: false,
      code: 'VOICE_PROVIDER_CONFIG_MANAGED_EXTERNALLY',
      message: '语音供应商配置由主站统一配置中心管理，旧接口已停止写入',
    },
    { status: 410 },
  );
}

/** 更新引擎配置 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdminAuth(request, async () => {
    await params;
    return managedExternallyResponse();
  });
}

/** 删除引擎配置 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdminAuth(request, async () => {
    await params;
    return managedExternallyResponse();
  });
}
