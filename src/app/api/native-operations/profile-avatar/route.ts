import { createNativeProfileAvatarHandler } from "@/lib/server/native-profile-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createNativeProfileAvatarHandler();
export const POST = handle;
export const PUT = handle;
