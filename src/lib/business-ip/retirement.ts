// Explicit reviewed retirements only. Keep rows and conversations recoverable.
export const BIP_RETIREMENTS = [
 {id:'agent-1787158019361-luhpqn',name:'个人优势盘点助手',into:'商业IP定位',reason:'经历、能力、资源盘点合并，取消定位前的独立入口'},
 {id:'agent-1787158020426-97mzw2',name:'专业信任素材助手',into:'商业IP定位、内容选题策划',reason:'证据盘点、采证动作及内容化合并'},
 {id:'agent-1787158020744-6hgopa',name:'产品与变现设计助手',into:'商业IP定位',reason:'产品交付、付费理由和商业承接合并'},
 {id:'agent-1781436844473-9zws4v',name:'人群画像洞察',into:'商业IP定位',reason:'人群任务与购买场景合并；旧指令预设未接入数据工具与行业基准'},
 {id:'agent-1787158019786-j1eah4',name:'对标账号差异分析',into:'对标账号拆解',reason:'旧版无采集工具、无样本对照和原创迁移合同，由七环中的工具型对标研究入口替代'},
 {id:'agent-1787158021072-bwsuu5',name:'账号定位试跑助手',into:'商业IP定位、运营数据复盘',reason:'两周定位验证与后续试跑合并'},
 {id:'agent-aiweb-acc625791107',name:'实体号起盘师',into:'商业IP定位、账号主页包装、内容选题策划',reason:'定位包装选题重复；旧版默认数量优先矩阵缺少资源和证据门槛'},
 {id:'agent-aiweb-ffdcb333b52a',name:'心理学用户洞察',into:'商业IP定位',reason:'人群、购买动机与顾虑分析重复，按证据推导替代泛画像'},
 {id:'agent-aiweb-47e45179d9bf',name:'象限选题军师',into:'内容选题策划',reason:'保留选题远近方法，合并为一个选题入口'},
 {id:'agent-aiweb-6facd43bb0bb',name:'泛流量选题师',into:'内容选题策划',reason:'泛话题筛选合并，避免与商业相关性脱节'},
 {id:'agent-1787160183517-6ofqqk',name:'客户跟进流程助手',into:'咨询回复与跟进',reason:'将咨询回复与手动跟进规则合并进平台通用咨询底座与标准会员业务数据协议'},
 {id:'agent-1787160183824-6gb7lr',name:'营销方案对比助手',into:'运营数据复盘',reason:'单变量对比与停止条件合并'},
 {id:'agent-aiweb-780dd9d21bb2',name:'门店获客引擎',into:'短视频文案成稿',reason:'通用门店口播重复，旧提示词包含能带来大量精准客户的无证据表述'},
 {id:'agent-aiweb-1a6d2786c028',name:'AI品牌铸造',into:'既有自用智能体命名包装师',reason:'实际是智能体品牌命名，与商业IP商家定位无关且已有内部专用工具'},
] as const;
