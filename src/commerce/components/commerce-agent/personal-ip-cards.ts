import observed from './observed-catalog.json';

const presentations=[
  {key:'personal-story',name:'个人故事',description:'回顾往事，讲述亲身经历'},
  {key:'personal-diary',name:'日常记录',description:'记录日常，展现真实生活'},
  {key:'personal-advice',name:'经验分享',description:'拆解做法，分享实用技巧'},
  {key:'personal-opinion',name:'观点表达',description:'围绕话题，分享个人看法'}
];

// These four menu entries use the general director with their own scene brief.
const referenceSlots=observed.directors.find(card=>card.key==='face-slap-reversal')!.slots;
export const personalIpCards=presentations.map((card,index)=>({
  ...card,category:'个人IP',default:false,recommended:false,options:[],
  sortOrder:1000+index,recommendationOrder:0,benchmarkConfigVersion:'',
  icon:'/commerce/reference/'+card.key+'.png',slots:referenceSlots,
}));
// test-* keys are the benchmark's aliases of the four personal-IP scenes; the
// local visual cards below already present the same entries, so exclude the
// aliases to avoid duplicate sidebar cards.
export const visualDirectorCatalog=[...observed.directors.filter(card=>!card.key.startsWith('test-')),...personalIpCards];
