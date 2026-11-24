export const videoPath='/toolbox/video-generation',imagePath='/toolbox/image-generation';
export const groupKeys:Record<string,string>={'创意带货':'creative-selling','电商带货':'ecommerce','同城到店':'local-store','品牌广告':'brand','剧情短片':'drama','短剧编导':'short-drama','个人IP':'personal-ip'};
export const sceneKeys:Record<string,string>={
  'ecommerce-spoken-selling':'spoken-product','ecommerce-promotion-conversion':'promotion','ecommerce-scene-seeding':'scenario-seeding',
  'ecommerce-pain-point-solution':'problem-solution','ecommerce-function-demo':'feature-demo','local-store-discovery':'store-discovery',
  'local-store-visit-record':'store-visit','local-store-signature-experience':'signature-experience','local-store-group-buy-conversion':'local-store-group-buy-conversion',
  'advertising-brand-proposition':'brand-product-showcase','advertising-brand-story':'brand-benefit','advertising-lifestyle':'brand-creative-ad',
  'advertising-creative-concept':'brand-concept','short-drama-dialogue':'dialogue-drama','short-drama-reversal':'twist-drama',
  'short-drama-suspense':'suspense-drama','short-drama-emotional':'emotional-short','short-drama-product-placement':'product-placement',
  'personal-story':'personal-story',
  'personal-diary':'personal-diary',
  'personal-advice':'personal-advice',
  'personal-opinion':'personal-opinion',
  'face-slap-reversal':'reversal-payoff',
  'pcc62f09b-6a69c3':'drama-selling','pcc62f09b-6d3d7e':'thai-selling','pcc62f09b-c92a82':'absurd-selling','pcc62f09b-d5eb08':'reverse-attribution-ad',
  'test-characterstories':'personal-story','test-dailydocumentary':'personal-diary','test-experience':'personal-advice','test-opinion':'personal-opinion'
};
export const imageKeys:Record<string,string>={
  'face-turnaround':'face-views','character-sheet':'character-views','change-face':'model-face-replace','face-fusion':'face-blend',
  'change-cloth':'virtual-try-on','product-use':'product-in-use','white-background':'white-background','clothing-redesign':'garment-variation',
  'background-change':'person-in-scene','portrait-realism':'photoreal-person','image-refine':'retouch'
};
export const scenarioPath:Record<string,string>={replicate:'/toolbox/hot-video-remix',detail:'/toolbox/ecommerce-image-set',ecommerce:videoPath+'?group=ecommerce',local:videoPath+'?group=local-store',brand:videoPath+'?group=brand',drama:videoPath+'?group=drama','image-create':imagePath};
