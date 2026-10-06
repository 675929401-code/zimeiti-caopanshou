import {NextResponse} from 'next/server';
import {primePublishedCommerceConfiguration} from '../../../../commerce/server/configuration-platform';
import {models,type Kind} from '../../../../commerce/server/models';
import {commerceModelAcceptanceIndex,commerceModelAcceptanceKey} from '../../../../commerce/server/model-acceptance';
export const dynamic='force-dynamic';
export async function GET(){
 const configurationRequired=process.env.SHARED_CONFIGURATION_ENABLED==='1';
 let configurationReady=!configurationRequired,readyForPaidJobs=!configurationRequired,configurationMode='disabled',providerAcceptance=configurationRequired?'pending':'not-required';
 if(configurationRequired)try{
  const configuration=await primePublishedCommerceConfiguration({required:true});configurationReady=true;readyForPaidJobs=configuration?.paidJobsReady===true;configurationMode=configuration?.validationMode||'missing';
  if(configuration){
   try{
    const kinds:Kind[]=['agent','image','video'];const [catalogs,acceptance]=await Promise.all([Promise.all(kinds.map(kind=>models(kind))),commerceModelAcceptanceIndex()]);
    providerAcceptance=kinds.every((kind,index)=>{const id=configuration.defaultModels[kind];if(!id)return false;const model=catalogs[index].find(item=>item.id===id);return Boolean(model&&acceptance.has(commerceModelAcceptanceKey(kind,id,model.configHash)));})?'complete':'pending';
   }catch{providerAcceptance='unavailable';}
  }
 }catch{configurationReady=false;readyForPaidJobs=false;configurationMode='unavailable';providerAcceptance='unavailable';}
 return NextResponse.json({
  application:'commerce-agent',
  host:'main-site',
  runtimeMode:'integrated',
  configurationAuthority:'main-shared-configuration',
  configurationRequired,
  configurationReady,
  configurationMode,
  readyForPaidJobs,
  taskHistoryStorage:'commerce-sqlite',
  providerAcceptance,
  overallComplete:false,
  runtime:process.env.NODE_ENV,
 },{headers:{'Cache-Control':'no-store'}});
}
