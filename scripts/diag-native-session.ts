import { createClient } from "@supabase/supabase-js";
import { readNativeHostSession } from "../src/lib/server/native-operations-service";

async function main() {
  const url = process.env.COZE_SUPABASE_URL!;
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!;
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const user = { id: "b5cccb94-1d77-4e14-9391-fb3e6f823486", username: "18685178259", displayName: "朱俊果", role: "admin" } as any;
  try {
    const result = await readNativeHostSession(user, db as any, "a".repeat(90));
    console.log("SUCCESS", JSON.stringify(result));
  } catch (error) {
    console.log("ERROR_NAME", (error as any)?.name);
    console.log("ERROR_MSG", (error as any)?.message);
    console.log("ERROR_STACK", String((error as any)?.stack || "").slice(0, 5000));
    if (error instanceof Error && "issues" in error) console.log("ISSUES", JSON.stringify((error as any).issues));
  }
}
main();