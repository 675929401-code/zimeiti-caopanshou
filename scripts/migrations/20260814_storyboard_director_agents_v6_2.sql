-- Compatibility migration. It preserves the existing director strategy, asset
-- locking, 10-style dictionary, semantic packaging and visual method. It only
-- upgrades the stable input/output contract for adaptive 8/10/15-second units.
BEGIN;

DO $preflight$
DECLARE
  target_count integer;
  invalid_name_count integer;
  invalid_core_count integer;
  invalid_anchor_count integer;
  invalid_layout_pacing_source_count integer;
BEGIN
  SELECT count(*) INTO target_count
  FROM agents
  WHERE id IN (
    'agent-1786633444187-594spj',
    'agent-1786642714227-e1zid1',
    'agent-1786642714448-m6iaou'
  )
    AND deleted_at IS NULL;
  IF target_count <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 preflight failed: expected 3 live targets, found %', target_count;
  END IF;

  SELECT count(*) INTO invalid_name_count
  FROM agents
  WHERE (id = 'agent-1786633444187-594spj' AND name <> '故事版导演｜高能夸张')
     OR (id = 'agent-1786642714227-e1zid1' AND name <> '故事版导演｜电影叙事')
     OR (id = 'agent-1786642714448-m6iaou' AND name <> '故事版导演｜抒情情感');
  IF invalid_name_count <> 0 THEN
    RAISE EXCEPTION 'storyboard v6.2 preflight failed: unexpected target names';
  END IF;

  SELECT count(*) INTO invalid_core_count
  FROM agents
  WHERE id IN (
    'agent-1786633444187-594spj',
    'agent-1786642714227-e1zid1',
    'agent-1786642714448-m6iaou'
  )
    AND (
      system_prompt IS NULL
      OR system_prompt NOT LIKE '%# 全片资产锁定%'
      OR system_prompt NOT LIKE '%# 口播转故事的方法%'
      OR system_prompt NOT LIKE '%# 语义包装%'
      OR system_prompt NOT LIKE '%# 3D风格执行字典%'
      OR system_prompt NOT LIKE '%# 故事板生图Prompt写法%'
      OR system_prompt NOT LIKE '%# 图生视频Prompt写法%'
    );
  IF invalid_core_count <> 0 THEN
    RAISE EXCEPTION 'storyboard v6.2 preflight failed: one or more director cores are incomplete';
  END IF;

  SELECT count(*) INTO invalid_anchor_count
  FROM agents
  WHERE id IN (
    'agent-1786633444187-594spj',
    'agent-1786642714227-e1zid1',
    'agent-1786642714448-m6iaou'
  )
    AND (
      strpos(system_prompt, '# 固定输出格式') = 0
      OR strpos(
        substr(system_prompt, strpos(system_prompt, '# 固定输出格式') + length('# 固定输出格式')),
        '# 固定输出格式'
      ) > 0
    );
  IF invalid_anchor_count <> 0 THEN
    RAISE EXCEPTION 'storyboard v6.2 preflight failed: output anchor must occur exactly once';
  END IF;

  SELECT count(*) INTO invalid_layout_pacing_source_count
  FROM agents
  WHERE id IN (
    'agent-1786633444187-594spj',
    'agent-1786642714227-e1zid1',
    'agent-1786642714448-m6iaou'
  )
    AND system_prompt NOT LIKE '%故事板面板只是视觉素材与动作覆盖，不是切镜清单%'
    AND system_prompt NOT LIKE '%把完整故事板按Frame 1至Frame N作为连续时序%';
  IF invalid_layout_pacing_source_count <> 0 THEN
    RAISE EXCEPTION 'storyboard v6.2 preflight failed: unknown layout/pacing source text';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS agent_config_migration_backups (
  migration_key text NOT NULL,
  agent_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_key, agent_id)
);

ALTER TABLE agent_config_migration_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agent_config_migration_backups FROM anon, authenticated;
GRANT ALL ON TABLE agent_config_migration_backups TO service_role;

INSERT INTO agent_config_migration_backups (migration_key, agent_id, payload)
SELECT
  '20260814_storyboard_director_agents_v6_2',
  id,
  jsonb_build_object(
    'name', name,
    'description', description,
    'category', category,
    'source', source,
    'model', model,
    'model_id', model_id,
    'is_active', is_active,
    'user_access', user_access,
    'sort_order', sort_order,
    'system_prompt', system_prompt,
    'preset_fields', preset_fields,
    'output_style', output_style,
    'response_format', response_format,
    'max_context_rounds', max_context_rounds,
    'max_context_tokens', max_context_tokens,
    'max_reply_tokens', max_reply_tokens,
    'temperature', temperature,
    'timeout', timeout,
    'enable_web_search', enable_web_search,
    'guide_message', guide_message,
    'updated_at', updated_at
  )
FROM agents
WHERE id IN (
  'agent-1786633444187-594spj',
  'agent-1786642714227-e1zid1',
  'agent-1786642714448-m6iaou'
)
  AND deleted_at IS NULL
ON CONFLICT (migration_key, agent_id) DO NOTHING;

DO $backup_check$
BEGIN
  IF (
    SELECT count(*)
    FROM agent_config_migration_backups
    WHERE migration_key = '20260814_storyboard_director_agents_v6_2'
      AND agent_id IN (
        'agent-1786633444187-594spj',
        'agent-1786642714227-e1zid1',
        'agent-1786642714448-m6iaou'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 backup failed: expected exactly 3 backup rows';
  END IF;
END
$backup_check$;

-- The admin history table has no note column. Prefixing this history-only copy
-- makes the version label visible without altering the exact rollback snapshot.
INSERT INTO prompt_versions (agent_id, prompt)
SELECT
  id,
  '<!-- v6.2 前置备份/8-10-15秒适配前 -->' || E'\n' || system_prompt
FROM agents
WHERE id IN (
  'agent-1786633444187-594spj',
  'agent-1786642714227-e1zid1',
  'agent-1786642714448-m6iaou'
)
  AND deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM prompt_versions
    WHERE prompt_versions.agent_id = agents.id
      AND prompt_versions.prompt LIKE '<!-- v6.2 前置备份/8-10-15秒适配前 -->%'
  );

DO $history_check$
BEGIN
  IF (
    SELECT count(*)
    FROM prompt_versions
    WHERE agent_id IN (
      'agent-1786633444187-594spj',
      'agent-1786642714227-e1zid1',
      'agent-1786642714448-m6iaou'
    )
      AND prompt LIKE '<!-- v6.2 前置备份/8-10-15秒适配前 -->%'
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 history backup failed: expected exactly 3 visible versions';
  END IF;
END
$history_check$;

WITH modes AS (
  SELECT * FROM (VALUES
    ('agent-1786633444187-594spj'::text, 'high_energy'::text),
    ('agent-1786642714227-e1zid1'::text, 'cinematic'::text),
    ('agent-1786642714448-m6iaou'::text, 'lyrical'::text)
  ) AS value(agent_id, director_mode)
), protocol AS (
  SELECT $protocol$
# 稳定输入协议 v6.2
优先读取稳定字段 segmented_script、animation_style、aspect_ratio、target_duration_seconds、special_notes。target_duration_seconds 只能为8、10或15，缺失时按10处理。兼容旧字段 storyboard_segmented_copy、storyboard_visual_style、storyboard_aspect_ratio、storyboard_character_setting、storyboard_special_requirements；旧角色设定与旧特殊要求合并为 special_notes。字段显示名称和排列顺序可以变化，字段 ID 的语义不变。

# 固定输出格式（稳定协议 v6.2）
不展示分析，不寒暄。严格保留原段落编号、边界、顺序和原字。每段先输出一个独立的标准 Markdown text 代码框“生图 Prompt”，再输出一个独立的标准 Markdown text 代码框“图生视频 Prompt”。两个代码框都必须能脱离解释直接复制提交。

每段格式：
**原文案内容段落 N**：逐字放入该段原文
**生图 Prompt（共4格或5格）**：一个 text 代码框，只放完整故事板生图 Prompt
**图生视频 Prompt（实际N个镜头）**：一个 text 代码框，只放完整动作型视频 Prompt

所有段落结束后，再输出一个标准 json 代码框作为机器包。平台不得按标题、代码框位置或顺序猜字段，只能读取以下稳定合同：
schema_version 固定为 storyboard_director_output.v1；artifact_type 固定为 storyboard_director_package；director_mode 固定为 {{DIRECTOR_MODE}}；input 固定包含 schema_version=storyboard_director_input.v1、segmented_script、animation_style、aspect_ratio、target_duration_seconds、special_notes；segments 每项固定包含 segment_id、source_index、narration、target_duration_seconds、estimated_narration_duration、panel_count、layout、pacing_mode、actual_shot_count、shot_time_ranges、panoramic_anchor_role、continuity_links、character_assets、semantic_visualizations、storyboard_image_prompt、image_to_video_prompt；shot_time_ranges 每项包含 shot_id、start_seconds、end_seconds、action_beat；continuity_links 每项包含 from_shot、to_shot、link_type、description；semantic_visualizations 每项包含 trigger、visual_form、interaction。

storyboard_image_prompt 与该段生图代码框逐字一致，image_to_video_prompt 与该段视频代码框逐字一致。segment_id 使用 segment_001、segment_002 的稳定形式。panel_count 只能为4或5；四格时 layout=two_by_two 且 panoramic_anchor_role=null；五格时 layout=four_plus_panorama，并填写第5格独立承担的高潮、结论、警示揭示、空间全貌或情绪收束职责。pacing_mode 只能为 slow、medium、fast；actual_shot_count 只能为1至5。

输出前检查：原文无损；具体角色资产完整；按约6字/秒估算口播，并加0.3至0.8秒自然停顿，写入 estimated_narration_duration。先提取不可合并的视觉节拍：8秒通常4格；10秒4或5格自适应；15秒通常5格，低信息或抒情仍可4格；只有确有独立高潮、结论、警示、空间全貌或情绪收束时才加第5格，永远不超过5格，语义超载时建议拆为下一生成单元。五格生图 Prompt 必须原样包含“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”，禁止上2下3等宽、五张独立图或错序拼贴。语义包装来自本句并先画入故事板；医学演示保持局部、友好、无不适。面板数与实际镜头数解耦：8秒高能2至3镜、电影2至3镜、抒情1至2镜；10秒高能3至4镜、电影2至3镜、抒情1至2镜；15秒高能4至5镜、电影3至4镜、抒情2至3镜。只有语义需要才取上限，不为凑数切镜。shot_time_ranges 连续覆盖完整目标时长；continuity_links 写清动作、视线、声音或空间如何衔接。视频 Prompt 用大白话写清实际镜头数、每镜起止秒、表演、运镜、物理反馈、声音边界和禁止项。任何一项不合格时内部重写后再输出。
$protocol$::text AS tail
)
UPDATE agents AS agent
SET
  system_prompt = replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
          replace(
            replace(
              replace(
                left(
                  agent.system_prompt,
                  strpos(agent.system_prompt, '# 固定输出格式') - 1
                ),
                '- 4格用整齐2×2版式；5格用上方2×2四格加底部第5格横向全宽；比例严格使用用户选择的16:9或9:16；',
                '- 先提取不可合并的视觉节拍：语义只有四个有效节拍或第五格没有独立叙事价值时，用标准2×2四格；上方四格分别承担动作准备、触发、反应、转折，并改变景别、机位和动作阶段，不得只是监控视角换位；只有段落存在值得单独表现的高潮、结论、警示揭示、空间全貌或情绪收束时才使用5格，并明确写入“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”；禁止为了版式硬凑第五格、上2下3等宽、五张独立图或错序拼贴；比例严格使用用户选择的16:9或9:16；'
              ),
              '第一句只写必要读取协议：把完整故事板按Frame 1至Frame N作为连续时序，生成约10秒正常全屏视频；每格只作相应镜头的角色、构图和动作依据；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型、眼睛比例、毛发与布料渲染，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。',
              '第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成用户选择的8、10或15秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按目标时长、情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。'
            ),
            '随后每格一行，使用直白命令：',
            '随后按实际镜头数逐镜写，使用直白命令：'
          ),
          '`Frame N（起止秒）：镜头怎样移动；主体从什么明确姿势开始，连续做什么；另一角色、道具和环境怎样发生可见反应；故事板已有包装怎样出现、运动或消失；用动作、视线、方向、道具或特效怎样交给下一格。`',
          '`镜头N（起止秒）：镜头怎样移动；主体从什么明确姿势开始，连续做什么；另一角色、道具和环境怎样发生可见反应；故事板已有包装怎样出现、运动或消失；用动作、视线、方向、道具或特效怎样完成镜内推进或交给下一镜头。`'
        ),
        '- 四格每格约2至2.5秒；五格每格约1.6至2.2秒，高潮可稍长；最后一格留出稳定落幅；',
        '- 镜头数按目标时长与导演模式自适应：8秒高能2至3个、电影2至3个、抒情1至2个；10秒高能3至4个、电影2至3个、抒情1至2个；15秒高能4至5个、电影3至4个、抒情2至3个；只在语义需要时取上限，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；'
      ),
      '8. 生图与视频Frame数量、事件、包装和顺序一一对应；',
      '8. 生图面板提供连续空间、事件和包装素材，视频按语义合并调用，不要求面板数与实际镜头数相等；'
    ),
              '9. 视频每格都是动作命令，能在分配秒数内演完，总长度不超过3500字；',
              '9. 视频按实际镜头数写动作命令，明确每镜起止秒并在用户选择的8、10或15秒内演完，总长度不超过3500字；'
            ),
            '第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成约10秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。',
            '第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成用户选择的8、10或15秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按目标时长、情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。'
          ),
          '- 10秒普通段落使用2至3个实际镜头；高能夸张通常2至4个、电影叙事2至3个、抒情情感1至2个；每镜约2.5至5秒，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；',
          '- 镜头数按目标时长与导演模式自适应：8秒高能2至3个、电影2至3个、抒情1至2个；10秒高能3至4个、电影2至3个、抒情1至2个；15秒高能4至5个、电影3至4个、抒情2至3个；只在语义需要时取上限，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；'
        ),
        '9. 视频按实际镜头数写动作命令，明确每镜时长并能在约10秒内演完，总长度不超过3500字；',
        '9. 视频按实际镜头数写动作命令，明确每镜起止秒并在用户选择的8、10或15秒内演完，总长度不超过3500字；'
      )
  ) || replace(protocol.tail, '{{DIRECTOR_MODE}}', modes.director_mode),
  preset_fields = jsonb_build_array(
    jsonb_build_object(
      'id', 'segmented_script',
      'label', '已分段口播文案',
      'type', 'textarea',
      'placeholder', E'例如：1.【第一段……】\n2.【第二段……】',
      'required', true,
      'options', jsonb_build_array(),
      'order', 0,
      'sendLabel', true,
      'sendText', 'segmented_script',
      'description', '保留原段落编号、边界、顺序和字句，不重新拆段。'
    ),
    jsonb_build_object(
      'id', 'animation_style',
      'label', '3D动画风格',
      'type', 'select',
      'placeholder', '选择全片统一的3D动画风格',
      'required', true,
      'options', jsonb_build_array(
        '高能商业3D动画喜剧（皮克斯式）',
        '童话电影3D动画（迪士尼式）',
        '欧美反差3D动画喜剧（梦工厂式）',
        '高饱和萌宠3D动画喜剧（照明娱乐式）',
        '温暖家庭3D动画电影',
        '电影级半写实3D动画',
        '手工黏土定格质感3D动画',
        'Q版玩具模型3D动画',
        '东方国潮3D动画电影',
        '未来科技霓虹3D动画'
      ),
      'order', 1,
      'sendLabel', true,
      'sendText', 'animation_style'
    ),
    jsonb_build_object(
      'id', 'aspect_ratio',
      'label', '画面尺寸',
      'type', 'select',
      'placeholder', '选择横屏或竖屏',
      'required', true,
      'options', jsonb_build_array('16:9', '9:16'),
      'order', 2,
      'sendLabel', true,
      'sendText', 'aspect_ratio'
    ),
    jsonb_build_object(
      'id', 'target_duration_seconds',
      'label', '目标视频时长',
      'type', 'select',
      'placeholder', '选择 8、10 或 15 秒',
      'required', true,
      'options', jsonb_build_array('8', '10', '15'),
      'order', 3,
      'defaultValue', '10',
      'sendLabel', true,
      'sendText', 'target_duration_seconds',
      'description', '默认10秒；时长影响表演容量和镜头节奏，不机械决定镜头数。'
    ),
    jsonb_build_object(
      'id', 'special_notes',
      'label', '特殊备注',
      'type', 'textarea',
      'placeholder', '选填：角色品种、毛色、年龄、服装、真实产品参考、禁用内容等。',
      'required', false,
      'options', jsonb_build_array(),
      'order', 4,
      'sendLabel', true,
      'sendText', 'special_notes',
      'description', '仅在这里明确要求时绑定外部角色或产品参考资产。'
    )
  ),
  output_style = jsonb_build_object(
    'schema_version', 'storyboard_director_output_style.v1',
    'artifact_type', 'storyboard_director_package',
    'director_mode', modes.director_mode,
    'machine_schema', 'storyboard_director_output.v1',
    'human_format', 'markdown_two_text_blocks_per_segment_plus_json',
    'panel_layout', 'adaptive_four_or_four_plus_panorama',
    'target_durations', jsonb_build_array(8, 10, 15),
    'shot_pacing', 'duration_adaptive_semantic_one_to_five_shots'
  ),
  response_format = 'markdown',
  max_context_rounds = 1,
  max_context_tokens = 0,
  max_reply_tokens = 32768,
  guide_message = '粘贴已分段口播文案，选择3D动画风格、尺寸和8/10/15秒目标时长；每段将输出独立生图 Prompt、图生视频 Prompt 和稳定机器包。',
  updated_at = now()
FROM modes CROSS JOIN protocol
WHERE agent.id = modes.agent_id;

DO $postcondition$
BEGIN
  IF (
    SELECT count(*)
    FROM agents
    WHERE id IN (
      'agent-1786633444187-594spj',
      'agent-1786642714227-e1zid1',
      'agent-1786642714448-m6iaou'
    )
      AND deleted_at IS NULL
      AND system_prompt LIKE '%# 全片资产锁定%'
      AND system_prompt LIKE '%# 口播转故事的方法%'
      AND system_prompt LIKE '%# 语义包装%'
      AND system_prompt LIKE '%# 3D风格执行字典%'
      AND system_prompt LIKE '%# 故事板生图Prompt写法%'
      AND system_prompt LIKE '%# 图生视频Prompt写法%'
      AND system_prompt LIKE '%storyboard_director_output.v1%'
      AND system_prompt LIKE '%target_duration_seconds、estimated_narration_duration、panel_count、layout、pacing_mode、actual_shot_count、shot_time_ranges、panoramic_anchor_role、continuity_links%'
      AND system_prompt LIKE '%top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel%'
      AND system_prompt LIKE '%故事板面板只是视觉素材与动作覆盖，不是切镜清单%'
      AND system_prompt NOT LIKE '%四格每格约2至2.5秒%'
      AND system_prompt NOT LIKE '%五格每格约1.6至2.2秒%'
      AND system_prompt NOT LIKE '%生成约10秒正常全屏视频%'
      AND system_prompt NOT LIKE '%10秒普通段落使用2至3个实际镜头%'
      AND system_prompt NOT LIKE '%约10秒内演完%'
      AND system_prompt NOT LIKE '%不输出JSON%'
      AND jsonb_typeof(preset_fields) = 'array'
      AND jsonb_array_length(preset_fields) = 5
      AND preset_fields->0->>'id' = 'segmented_script'
      AND preset_fields->1->>'id' = 'animation_style'
      AND preset_fields->2->>'id' = 'aspect_ratio'
      AND preset_fields->3->>'id' = 'target_duration_seconds'
      AND preset_fields->3->>'defaultValue' = '10'
      AND preset_fields->4->>'id' = 'special_notes'
      AND jsonb_array_length(preset_fields->1->'options') = 10
      AND jsonb_array_length(preset_fields->3->'options') = 3
      AND response_format = 'markdown'
      AND max_reply_tokens = 32768
      AND (
        (id = 'agent-1786633444187-594spj'
          AND output_style->>'director_mode' = 'high_energy'
          AND system_prompt LIKE '%director_mode 固定为 high_energy%')
        OR (id = 'agent-1786642714227-e1zid1'
          AND output_style->>'director_mode' = 'cinematic'
          AND system_prompt LIKE '%director_mode 固定为 cinematic%')
        OR (id = 'agent-1786642714448-m6iaou'
          AND output_style->>'director_mode' = 'lyrical'
          AND system_prompt LIKE '%director_mode 固定为 lyrical%')
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 postcondition failed; rolling back transaction';
  END IF;
END
$postcondition$;

INSERT INTO prompt_versions (agent_id, prompt)
SELECT id, '<!-- 故事版导演 v6.2 / 8-10-15秒适配 -->' || E'\n' || system_prompt
FROM agents
WHERE id IN (
  'agent-1786633444187-594spj',
  'agent-1786642714227-e1zid1',
  'agent-1786642714448-m6iaou'
)
AND NOT EXISTS (
  SELECT 1
  FROM prompt_versions
  WHERE prompt_versions.agent_id = agents.id
    AND prompt_versions.prompt = '<!-- 故事版导演 v6.2 / 8-10-15秒适配 -->' || E'\n' || agents.system_prompt
);

COMMIT;
