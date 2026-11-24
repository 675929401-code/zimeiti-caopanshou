export const directorStartBriefs: Readonly<Record<string, { title: string; fields: readonly string[] }>> = {
  'ecommerce-spoken-selling': {
    title: '口播带货任务单',
    fields: ['商品与目标人群', '观众遇到的具体困扰', '能拍出来的商品演示或凭据', '出镜人和表达语气', '希望观众采取的动作'],
  },
  'ecommerce-scene-seeding': {
    title: '场景种草任务单',
    fields: ['商品与真实使用场景', '人物在场景里要完成的事', '商品怎样自然出现并被使用', '镜头能看到的前后变化', '想让哪些人产生使用兴趣'],
  },
  'local-store-group-buy-conversion': {
    title: '同城团购任务单',
    fields: ['门店名称与到店位置', '套餐内容、份数与适用人数', '价格与有效期', '预约条件与不可用日期', '真实购买入口与核销方式'],
  },
};
