import {NextResponse} from 'next/server';

import {requireIdentity} from '../../../../commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '../../../../commerce/server/main-account-access';
import {COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION,listDigitalHumanAudioCandidates} from '../../../../commerce/server/digital-human-audio-candidates';
import {errorResponse} from '../../../../commerce/server/http';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request){
 try{
  const identity=requireIdentity(request);
  await authorizeCurrentCommerceIdentity(identity);
  return NextResponse.json(
   {schema:COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION,assets:listDigitalHumanAudioCandidates(identity.id)},
   {headers:{'Cache-Control':'private, no-store'}},
  );
 }catch(error){return errorResponse(error);}
}
