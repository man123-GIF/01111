#!/usr/bin/env node

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "de1.bot-hosting.cloud";                  // 直接使用面板分配域名
const ARGO_PORT = process.env.ARGO_PORT || 25644;                    // 直接使用分配端口

const CFIP = process.env.CFIP || "de1.bot-hosting.cloud";                 // 优选域名/IP，这里直接填面板域名
const CFPORT = process.env.CFPORT || 25644;                           // 端口，这里用25644
const NAME = process.env.NAME || "Argo_EasyShare";             

const FILE_PATH = process.env.FILE_PATH || ".tmp";
const URL_FILE_PATH = process.env.URL_FILE_PATH || "sub.txt"; 

const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const GO_BASE_ENV = {
  ...process.env,
  GODEBUG: "madvdontneed=1,cgocheck=0",
  GOMAXPROCS: "1",
  GOGC: "50"
};

const rawUUID = process.env.UUID || (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
}));

const UUID = rawUUID.toLowerCase();
const WS_PATH = `/${UUID}-vless`;
const log = (msg) => process.stdout.write(msg + "\n");

// 下载文件函数（直连模式不需要下载cloudflared，但保留以防万一）
function downloadFile(urlStr, targetPath) {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith("https") ? https : http;
    const req = client.get(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return downloadFile(res.headers.location, targetPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP 状态码异常: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          req.destroy();
          resolve();
        });
      });
    });
    req.on("error", (err) => {
      req.destroy();
      try { fs.unlinkSync(targetPath); } catch (e) {}
      reject(err);
    });
  });
}

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const webPath = path.join(FILE_PATH, "web");
const configPath = path.join(FILE_PATH, "config.json");

async function main() {
  // 构建 sing-box 配置，监听 25644 端口
  const config = {
    log: { level: "panic" },
    inbounds: [{
      type: "vless",
      tag: "vless-in",
      listen: "127.0.0.1",
      listen_port: parseInt(ARGO_PORT),
      users: [{ uuid: UUID }],
      transport: {
        type: "ws",
        path: WS_PATH
      }
    }],
    outbounds: [{ type: "direct", tag: "direct" }]
  };
  fs.writeFileSync(configPath, JSON.stringify(config));

  const isArm = ["arm", "arm64", "aarch64"].includes(os.arch());
  // 这里只下载 sing-box，不再下载 cloudflared
  const SINGBOX_VER = "1.11.4";
  const singboxTarUrl = isArm
    ? `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-arm64.tar.gz`
    : `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-amd64.tar.gz`;

  // 解压 sing-box 的逻辑
  function extractSingbox(tarPath, targetWebPath) {
    try {
      const { execSync } = require("child_process");
      execSync(`tar -xzf "${tarPath}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 || tar -xzf "${tarPath}" -C "${FILE_PATH}" sing-box`);
      const extractedPath = path.join(FILE_PATH, "sing-box");
      if (fs.existsSync(extractedPath)) {
        if (extractedPath !== targetWebPath) fs.renameSync(extractedPath, targetWebPath);
        return;
      }
    } catch (e) {}
    throw new Error("提取 sing-box 失败");
  }

  if (!fs.existsSync(webPath)) {
    log("正在下载 sing-box...");
    const tempTar = path.join(FILE_PATH, "singbox.tar.gz");
    await downloadFile(singboxTarUrl, tempTar);
    extractSingbox(tempTar, webPath);
    try { fs.unlinkSync(tempTar); } catch (e) {}
  }

  fs.chmodSync(webPath, 0o775);

  log("正在启动 sing-box 服务...");
  // 分配64MB内存给它
  let webProc = spawn(webPath, ["run", "-c", configPath], {
    env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: "64MiB" }),
    stdio: "ignore"
  });

  webProc.on("exit", (code) => {
    log(`[警告] sing-box 进程退出，退出码: ${code}`);
  });

  // 生成直连节点链接
  const plainNodeLink = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&fp=chrome&type=ws&host=${ARGO_DOMAIN}&path=${WS_PATH}#${NAME}`;
  log(`\n================== 直连节点链接 ==================\n${plainNodeLink}\n===================================================\n`);
  
  try {
    fs.writeFileSync(URL_FILE_PATH, plainNodeLink, "utf-8");
    log(`[成功！] 节点链接已保存至 ${URL_FILE_PATH}`);
  } catch (e) {
    log(`[错误！] 保存节点链接失败: ${e.message}`);
  }

  const cleanup = () => {
    try { webProc.kill("SIGKILL"); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdin.resume();
}

main().catch((err) => {
  log(`[致命错误] 主流程运行报错: ${err.message}`);
  process.exit(1);
});
