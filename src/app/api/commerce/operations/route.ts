import {operations} from '../../../../commerce/server/operation-routing';
import {primePublishedCommerceConfiguration} from '../../../../commerce/server/configuration-platform';
import {json} from '../../../../commerce/server/http';
export const dynamic='force-dynamic';
export async function GET(){await primePublishedCommerceConfiguration({required:process.env.SHARED_CONFIGURATION_ENABLED==='1'});return json({operations:operations().map(({modelId:_,promptId:__,fallbackModelIds:___,capabilityRequirements:____,...operation})=>operation)});}
