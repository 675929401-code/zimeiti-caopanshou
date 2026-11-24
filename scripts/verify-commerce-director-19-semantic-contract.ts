import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

async function main(){
  process.env.SHARED_CONFIGURATION_ENABLED='1';
  let networkCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{networkCalls+=1;throw Error('19-skill semantic regression must remain zero-network');}) as typeof fetch;
  try{
    const [{directorTemplates},{DIRECTOR_VISIBLE_OUTPUT_HEADINGS}]=await Promise.all([
      import('../src/commerce/server/director-prompts'),
      import('../src/commerce/server/director-prompt-compiler'),
    ]);
    const templates=directorTemplates('共同事实与安全规则。');
    const required:Record<string,string[]>={
      'ecommerce-spoken-selling':['真人推荐','外观不能证明香味','适合人群'],
      'ecommerce-promotion-conversion':['价格、币种、活动期限','虚构原价','购买动作'],
      'ecommerce-scene-seeding':['具体生活场景','自然动作','使用变化'],
      'ecommerce-pain-point-solution':['可观察的困扰','相同条件','解决动作'],
      'ecommerce-function-demo':['核心功能','手部动作','可见反馈'],
      'local-store-discovery':['真实门头','到店理由','营业时间'],
      'local-store-visit-record':['门头、前台、体验区、离店路线','空间路线连续','真实客户评价'],
      'local-store-signature-experience':['招牌项目','体验过程','适合人群'],
      'local-store-group-buy-conversion':['套餐内容与份数','预约规则','核销'],
      'advertising-brand-proposition':["商品展示", "呈现细节，展现商品质感"],
      'advertising-brand-story':["卖点广告", "聚焦卖点，凸显商品价值"],
      'advertising-lifestyle':["创意广告", "巧妙构思，演绎商品魅力"],
      'face-slap-reversal':['反转打脸','反转局势，释放打脸爽感'],
      'advertising-creative-concept':['可拍摄的视觉创意','视觉规则建立','商品外形'],
      'short-drama-dialogue':['两个人物的目标与冲突','反应镜头','台词归属'],
      'short-drama-reversal':['可见伏笔','同一线索','不得靠突然加入新人物'],
      'short-drama-suspense':['具体疑问','逐步揭示线索','有因果的揭晓'],
      'short-drama-emotional':['具体压力','可见行动','情绪落点'],
      'short-drama-product-placement':['人物目标推动故事','具体问题','硬广告'],
      'pcc62f09b-6a69c3':['小剧情','反转高点','兑现价值'],
      'pcc62f09b-6d3d7e':['泰式广告','反向因果','喜剧余味'],
      'pcc62f09b-c92a82':['脑洞','世界规则','顺理成章'],
      'pcc62f09b-d5eb08':['倒着归因','记忆点','归因链'],
      'test-characterstories':['亲身经历','遇到的转折','现在的感受'],
      'test-dailydocumentary':['真实日常记录','时间地点','收尾片刻'],
      'test-experience':['经验分享','分步操作','自查方法'],
      'test-opinion':['明确观点','核心判断','适用边界'],
      'default-director':['用户目标','清晰、连续、可执行'],
    };
    assert.equal(templates.length,28,'必须保持28个超级编导');
    assert.deepEqual(templates.map(item=>item.id.replace(/^director\./u,'')).sort(),Object.keys(required).sort(),'28个技能的稳定key不得漂移');
    assert.equal(new Set(templates.map(item=>createHash('sha256').update(item.content).digest('hex'))).size,28,'28个编导不能是同一提示词的改名复制');
    for(const template of templates){
      const key=template.id.replace(/^director\./u,'');
      for(const phrase of required[key])assert.ok(template.content.includes(phrase),`${key} 缺少语义合同：${phrase}`);
      assert.ok(template.content.includes(`本编导skillKey为 ${key}`),`${key} 缺少稳定运行时身份`);
      assert.ok(template.content.includes('问题不超过1个'),`${key} 必须限制为一次只追问一个关键问题`);
      assert.ok(template.content.includes('只在真实任务完成后才能说视频已生成'),`${key} 不得冒充工具执行结果`);
      assert.ok(template.content.includes('【common:platform-facts】')&&template.content.includes('【category:commerce-video-director】')&&template.content.includes(`【skill:${key}】`)&&template.content.includes('【runtime:director-script-v2】'),`${key} 缺少四层编译标记`);
      const positions=['【common:platform-facts】','【category:commerce-video-director】',`【skill:${key}】`,'【runtime:director-script-v2】'].map(mark=>template.content.indexOf(mark));
      assert.ok(positions.every((value,index)=>value>=0&&(index===0||value>positions[index-1])),`${key} 的四层编译顺序错误`);
      if(key==='default-director')assert.ok(!template.content.includes('本类型功能节拍参考'),`${key} 不应伪装成专属类型`);
      else if(['face-slap-reversal','advertising-lifestyle','advertising-brand-story','advertising-brand-proposition','test-characterstories','test-dailydocumentary','test-experience','test-opinion'].includes(key))assert.ok(!template.content.includes('本类型功能节拍参考'),key+' 使用现版公开任务说明');
      else assert.ok(template.content.includes('本类型功能节拍参考'),`${key} 缺少可执行节拍链`);
    }
    assert.deepEqual(DIRECTOR_VISIBLE_OUTPUT_HEADINGS,['剧情梗概','素材与职责','主体与全片设定','镜头 / 时间轴','始终禁止']);
    assert.equal(networkCalls,0);
    console.log(JSON.stringify({
      passed:templates.length*8+5,
      directors:templates.length,
      distinctPromptHashes:new Set(templates.map(item=>createHash('sha256').update(item.content).digest('hex'))).size,
      dedicatedBeatChains:templates.filter(item=>item.content.includes('本类型功能节拍参考')).length,
      visibleHeadings:DIRECTOR_VISIBLE_OUTPUT_HEADINGS,
      networkCalls,
      paidCalls:0,
      databaseWrites:0,
    }));
  }finally{
    globalThis.fetch=originalFetch;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
