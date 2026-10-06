import { getVoicePortraitPosition } from '@/lib/vs/avatar';
export default function VoicePortrait({speakerId,name,gender=''}:{speakerId:string;name:string;gender?:string}) {
 const {row,column}=getVoicePortraitPosition(speakerId,name,gender);
 return <span role="img" aria-label={name+'音色示意头像'} className="block h-full w-full" style={{backgroundImage:'url(/avatars/voice-studio/portraits.webp)',backgroundSize:'400% 300%',backgroundPosition:(column*100/3)+'% '+(row*50)+'%'}} />;
}
