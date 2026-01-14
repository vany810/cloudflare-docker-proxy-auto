addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

const getCustomDomain = () => {
  try {
    return CUSTOM_DOMAIN;
  } catch (e) {
    return "tyjmirror.xyz"; 
  }
};

const routes = (domain) => ({
  ["docker." + domain]: dockerHub,
  ["quay." + domain]: "https://quay.io",
  ["gcr." + domain]: "https://gcr.io",
  ["k8s-gcr." + domain]: "https://k8s.gcr.io",
  ["k8s." + domain]: "https://registry.k8s.io",
  ["ghcr." + domain]: "https://ghcr.io",
  ["cloudsmith." + domain]: "https://docker.cloudsmith.io",
  ["ecr." + domain]: "https://public.ecr.aws",
});

function routeByHosts(host) {
  const domain = getCustomDomain();
  const r = routes(domain);
  if (host in r) return r[host];
  if (typeof MODE !== 'undefined' && MODE === "debug") return typeof TARGET_UPSTREAM !== 'undefined' ? TARGET_UPSTREAM : dockerHub;
  return "";
}

/**
 * 核心修改：增加浏览器展示页面
 */
function renderHTML() {
  const domain = getCustomDomain();
  const r = routes(domain);
  const date = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Docker Mirror Status</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #f4f7f9; }
      .card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
      h1 { color: #0969da; border-bottom: 2px solid #eaecef; padding-bottom: 10px; }
      .status { display: inline-block; background: #2da44e; color: white; padding: 2px 10px; border-radius: 20px; font-size: 14px; }
      code { background: #f6f8fa; padding: 15px; border-radius: 6px; display: block; overflow-x: auto; border: 1px solid #d0d7de; margin: 10px 0; }
      ul { list-style: none; padding: 0; }
      li { padding: 8px 0; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; }
      .domain { font-weight: bold; color: #0550ae; }
      footer { margin-top: 40px; font-size: 12px; color: #666; text-align: center; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>🐳 Docker Mirror 加速站</h1>
      <p>系统状态: <span class="status">运行中 Running</span></p>
      <p>当前检查时间: <strong>${date} (2026)</strong></p>
      
      <h3>🚀 快速使用 (以 Alpine 为例)</h3>
      <code>docker pull docker.${domain}/library/alpine:latest</code>
      
      <h3>配置 Registry Mirror</h3>
      <code>
{
  "registry-mirrors": ["https://docker.${domain}"]
}
      </code>

      <h3>📊 已激活的路由</h3>
      <ul>
        ${Object.keys(r).map(key => `<li><span class="domain">${key}</span> ➜ <span>${r[key]}</span></li>`).join('')}
      </ul>
    </div>
    <footer>Powered by Cloudflare Workers | 2026-01-14</footer>
  </body>
  </html>
  `;
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);

  // 1. 修改：如果是浏览器直接访问根目录，展示 HTML 信息页
  if (url.pathname === "/") {
    const userAgent = request.headers.get("User-Agent") || "";
    // 判断是否为浏览器访问
    if (userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")) {
      return new Response(renderHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }
    // 非浏览器访问（如 curl）则重定向到 /v2/
    return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
  }

  if (upstream === "") {
    return new Response(JSON.stringify({ error: "Route not found", host: url.hostname }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const isDockerHub = upstream === dockerHub;
  const authorization = request.headers.get("Authorization");

  if (url.pathname === "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers(request.headers);
    const resp = await fetch(newUrl.toString(), { method: "GET", headers, redirect: "follow" });
    if (resp.status === 401) return responseUnauthorized(url);
    return resp;
  }

  if (url.pathname === "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), { method: "GET", redirect: "follow" });
    if (resp.status !== 401) return resp;
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (!authenticateStr) return resp;
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");

    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }

  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length === 5 && pathParts[2] !== "library") {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl, 301);
    }
  }

  const newUrl = new URL(upstream + url.pathname + url.search);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    redirect: isDockerHub ? "manual" : "follow",
  });
  newReq.headers.set("User-Agent", "Docker-Client/24.0.7 (linux)");

  const resp = await fetch(newReq);
  if (resp.status === 401) return responseUnauthorized(url);

  if (isDockerHub && resp.status === 307) {
    const location = resp.headers.get("Location");
    if (location) {
      return fetch(new Request(location, { method: "GET", headers: request.headers, redirect: "follow" }));
    }
  }
  return resp;
}

function parseAuthenticate(authenticateStr) {
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  return { realm: matches[0], service: matches[1] };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) url.searchParams.set("service", wwwAuthenticate.service);
  if (scope) url.searchParams.set("scope", scope);
  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  headers.set("User-Agent", "Docker-Client/24.0.7 (linux)");
  return await fetch(url, { method: "GET", headers });
}

function responseUnauthorized(url) {
  const headers = new Headers();
  const realm = `https://${url.host}/v2/auth`;
  headers.set("Www-Authenticate", `Bearer realm="${realm}",service="${url.host}"`);
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}
