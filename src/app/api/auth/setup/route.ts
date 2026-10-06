import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { hashPassword } from '@/lib/auth';
import { getServerSecret, isProductionRuntime, safeCompareSecret } from '@/lib/server-secrets';

type SetupRequestBody = {
  username?: string;
  password?: string;
  displayName?: string;
  setupToken?: string;
};

// POST - Initialize admin account (only works if no admin exists)
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as SetupRequestBody;
    const configuredSetupToken = getServerSecret('SETUP_TOKEN');
    const suppliedSetupToken = request.headers.get('x-setup-token') || body.setupToken || null;

    if (!safeCompareSecret(suppliedSetupToken, configuredSetupToken)) {
      return NextResponse.json({ error: '初始化入口已锁定，请配置并提供 SETUP_TOKEN' }, { status: 403 });
    }

    const client = getSupabaseClient();

    // Check if admin already exists
    const { data: existingAdmin } = await client
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .maybeSingle();

    if (existingAdmin) {
      return NextResponse.json({ error: '管理员账号已存在，不能重复初始化' }, { status: 409 });
    }

    const username = body.username?.trim() || 'admin';
    const password = body.password || (isProductionRuntime() ? '' : 'admin123456789');
    const displayName = body.displayName?.trim() || '管理员';

    if (password.length < 12) {
      return NextResponse.json({ error: '管理员初始密码至少需要 12 位' }, { status: 400 });
    }

    const passwordHash = await hashPassword(password);

    const { data, error } = await client
      .from('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: displayName,
        role: 'admin',
        credits: 99999,
      })
      .select('id, username, display_name, role, credits')
      .single();

    if (error) {
      return NextResponse.json({ error: `初始化管理员失败: ${error.message}` }, { status: 500 });
    }

    // Also seed default agents
    const defaultAgents = [
      {
        name: '视频创作助手',
        description: '专业短视频脚本创作，生成分镜和文生视频Prompt',
        avatar: '',
        category: '视频带货',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位专业的短视频创作助手。帮助用户创作短视频脚本，生成详细的分镜描述和文生视频Prompt。输出格式：每个分镜包含画面描述、旁白文案、文生视频Prompt。',
        cost_per_message: 10,
        sort_order: 1,
      },
      {
        name: '爆款文案仿写',
        description: '仿写爆款短视频/小红书/朋友圈文案',
        avatar: '',
        category: '文案/撰写',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位资深文案专家。擅长仿写和创作爆款文案，包括短视频文案、小红书种草文、朋友圈营销文案等。文案要抓人眼球、有情绪共鸣、引导行动。',
        cost_per_message: 10,
        sort_order: 2,
      },
      {
        name: '营销策略师',
        description: '用户分析、营销方案、投放优化建议',
        avatar: '',
        category: '营销策略',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位营销策略顾问。帮助用户进行用户分析、制定营销方案、优化投放策略。提供数据驱动的建议和可执行的方案。',
        cost_per_message: 10,
        sort_order: 3,
      },
      {
        name: '商业IP打造',
        description: '从0到1打造个人品牌和商业IP',
        avatar: '',
        category: '商业IP打造',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位商业IP打造专家。帮助用户从0到1打造个人品牌，包括人设定位、内容规划、变现模式、粉丝运营等全方位指导。',
        cost_per_message: 10,
        sort_order: 4,
      },
      {
        name: '消费者画像分析师',
        description: '消费者行为深度洞察与画像构建',
        avatar: '',
        category: '数据分析',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位消费者行为分析专家。帮助用户构建消费者画像，分析消费心理和行为模式，提供精准的受众定位建议。',
        cost_per_message: 10,
        sort_order: 5,
      },
      {
        name: '通用智能助手',
        description: '全能AI助手，回答各类问题',
        avatar: '',
        category: '通用',
        source: 'llm',
        model: 'deepseek-v4-flash',
        system_prompt: '你是一位智能助手，可以帮助用户回答各种问题，提供专业建议和创意灵感。',
        cost_per_message: 10,
        sort_order: 6,
      },
    ];

    const { error: agentsError } = await client.from('agents').insert(defaultAgents);

    if (agentsError) {
      console.error('Seed agents error:', agentsError);
    }

    return NextResponse.json({
      success: true,
      message: '管理员账号初始化成功',
      admin: data,
      hint: '请立即登录后台并开启正式运维配置',
    });
  } catch (err) {
    console.error('Setup error:', err);
    return NextResponse.json({ error: '初始化失败' }, { status: 500 });
  }
}
