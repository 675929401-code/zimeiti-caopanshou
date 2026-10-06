import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

// LEGACY_DEPLOY_DISABLED
console.error("BLOCKED: 旧 Gitee Webhook 部署入口已冻结；请勿启动监听服务。");
process.exit(2);

const port = Number(process.env.DEPLOY_WEBHOOK_PORT || 5055);
const secret = process.env.DEPLOY_WEBHOOK_SECRET || "";
const deployScript = process.env.DEPLOY_SCRIPT || "/data/agent-hub/deploy/git-auto-deploy.sh";
let running = false;

function timingSafeEqualText(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function triggerDeploy(mode = "full") {
  return new Promise((resolve, reject) => {
    if (running) {
      resolve({ skipped: true, reason: "deployment already running" });
      return;
    }

    running = true;
    const child = spawn("bash", [deployScript], {
      env: { ...process.env, DEPLOY_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      running = false;
      if (code === 0) resolve({ ok: true, output: output.slice(-4000) });
      else reject(new Error(`deploy exited with ${code}\n${output.slice(-4000)}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/gitee") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  try {
    if (!secret) throw new Error("DEPLOY_WEBHOOK_SECRET is not configured");

    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const tokenHeader = req.headers["x-gitee-token"];
    const password = payload.password || payload.hook_password || "";
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader || password;

    if (!timingSafeEqualText(token, secret)) {
      res.writeHead(401);
      res.end("invalid token");
      return;
    }

    const ref = payload.ref || "";
    if (ref && ref !== "refs/heads/main") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ skipped: true, reason: `ignored ref ${ref}` }));
      return;
    }

    const mode = "full";
    const result = await triggerDeploy(mode);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Gitee webhook server listening on 127.0.0.1:${port}`);
});
