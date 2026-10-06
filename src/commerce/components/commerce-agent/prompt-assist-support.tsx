import {Sparkles} from 'lucide-react';
export {api} from './runtime-ui';
export function ScriptPlaceholder({text}:{text:string}){return <div className="ca-assist-placeholder"><Sparkles size={32}/><p>{text}</p></div>;}
