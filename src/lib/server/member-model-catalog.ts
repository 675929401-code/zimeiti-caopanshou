import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import type { PublicModelDto } from "@/lib/public-model-dto";

// Direct server callers use the same catalog to bind a quote to an order.
// The marker belongs to this Request object and cannot arrive in an HTTP request.
export class BillingCatalogRequest extends Request {}

export async function catalogRatesForMember(request?: Request) {
  if (request instanceof BillingCatalogRequest) return true;
  const token = request && getTokenFromHeaders(request.headers);
  return Boolean(token && await verifyToken(token));
}

export function withoutCatalogRates({publicPrice, tokenPricing, capabilities, ...model}: PublicModelDto) {
  const {resolutionPrices, referenceImageUnitPrice, ...publicCapabilities} = capabilities;
  return {...model, capabilities: publicCapabilities};
}
