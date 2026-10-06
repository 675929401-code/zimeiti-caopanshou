import type {AssistApplication,VideoSettings} from '../../server/prompt-assist-schema';

type EditorReference={id:string;serverId?:string;slot:string};
/** Only a byte-for-byte matching editor draft can claim a validated application. */
export function matchingAssistApplication<T extends Pick<AssistApplication,'id'|'script'|'references'|'videoSettings'>>(application:T|null|undefined,script:string,references:EditorReference[],settings:VideoSettings):T|null {
 if(!application||!application.id||application.script!==script||!Array.isArray(application.references)||!application.videoSettings)return null;
 if(application.references.length!==references.length)return null;
 if(application.references.some((reference,index)=>reference.id!==(references[index].serverId||references[index].id)||reference.slot!==references[index].slot))return null;
 const target=application.videoSettings;
 return target.aspectRatio===settings.aspectRatio&&target.resolution===settings.resolution&&target.duration===settings.duration&&target.generateAudio===settings.generateAudio?application:null;
}
