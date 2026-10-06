/**
 * 触发同步部署到腾讯云服务器
 * 在管理后台保存设置、导航栏保存修改等操作后调用
 * 异步执行，不阻塞用户操作
 */

let lastDeployTime = 0;
const DEPLOY_COOLDOWN = 30000; // 30秒冷却，避免频繁触发

export async function triggerDeploySync(reason?: string): Promise<{ success: boolean; message: string }> {
  const now = Date.now();
  if (now - lastDeployTime < DEPLOY_COOLDOWN) {
    const remaining = Math.ceil((DEPLOY_COOLDOWN - (now - lastDeployTime)) / 1000);
    return { success: false, message: `部署冷却中，请${remaining}秒后再试` };
  }

  lastDeployTime = now;

  try {
    const response = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync', reason: reason || 'settings_save' }),
    });

    const data = await response.json();
    if (data.success) {
      console.log(`[Deploy] ${data.message}`);
    }
    return data;
  } catch (error) {
    console.error('[Deploy] 同步触发失败:', error);
    return { success: false, message: '同步触发失败' };
  }
}

export async function checkDeployStatus(): Promise<{ deploying: boolean; message: string }> {
  try {
    const response = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    });

    const data = await response.json();
    return { deploying: data.deploying || false, message: data.message || '' };
  } catch {
    return { deploying: false, message: '状态查询失败' };
  }
}
