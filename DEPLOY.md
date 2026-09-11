# 部署指南

项目现在**自带转换引擎**，所以部署到 Vercel 就能直接用，不需要额外的服务器。

---

## 一、最快路径：3 分钟部署到 Vercel

### 1. 推到 GitHub

```bash
git add -A
git commit -m "feat: 内置转换引擎，可独立部署到 Vercel"
git push origin master
```

### 2. 导入 Vercel

打开 <https://vercel.com/new> → 选这个仓库 → **Import**。

Framework Preset 选 **Other**，其余**什么都不用填**。
`vercel.json` 里已经配好了构建命令和输出目录：

| 配置项 | 值 |
| --- | --- |
| Build Command | `node scripts/vercel-build.mjs` |
| Output Directory | `public` |
| Node.js Version | 20.x 或更高 |

### 3. 点 Deploy

完成。打开 `https://<你的项目名>.vercel.app` 就能用了。

**不需要配任何环境变量，也不需要任何后端。**

### 4. 验证

```bash
# 页面能打开
curl -I https://<项目名>.vercel.app/

# 规则文件已部署
curl -s https://<项目名>.vercel.app/Clash/ZJU.list | head

# 规则配置里的规则源指向本站（自包含，不依赖 GitHub）
curl -s https://<项目名>.vercel.app/Clash/config/ZJU.ini | head -5

# 转换接口能跑（把 <订阅> 换成任意一个测试订阅地址）
curl "https://<项目名>.vercel.app/sub?url=<订阅>&config=/Clash/config/ZJU.ini" | head
```

最后一条如果返回 Clash YAML，就说明整条链路通了。
响应头里还会带上 `X-ZJU-Nodes` / `X-ZJU-Rules` / `X-ZJU-Groups`，方便排查。

---

## 二、它是怎么工作的

```
┌────────────────────────────────────────────────┐
│  Vercel                                        │
│                                                │
│  静态资源                 Serverless Function   │
│  ├─ index.html            ├─ /sub   ← 转换引擎  │
│  ├─ /Clash/**   规则文件   └─ /api/rules ← 规则清单│
│  └─ /configs/** 基础配置                        │
│                                                │
└────────────────────────────────────────────────┘
                     ▲
                     │ 订阅链接
        Clash / Mihomo / Shadowrocket 客户端
```

转换引擎（`lib/engine/`）是纯 JavaScript 写的，跟着 Serverless Function 一起部署，
所以：

- ✅ 不需要 Docker
- ✅ 不需要额外的服务器
- ✅ 不需要 subconverter
- ✅ 规则文件由本站自己托管，不依赖已经挂掉的上游仓库

内置引擎支持的客户端：`clash`、`clashr`、`mixed`（base64 节点列表）、`v2ray`、`ss`。

---

## 三、可选：想要 Surge / Quantumult X 格式

内置引擎只输出 Clash 系配置（这覆盖了绝大多数场景）。
如果你确实需要 Surge、Quantumult X、Loon、sing-box 等格式，可以再挂一个
[subconverter](https://github.com/tindy2013/subconverter)，这些 target 会自动转发过去。

```bash
# 在任意一台机器上起 subconverter
docker run -d --restart=always -p 25500:25500 tindy2013/subconverter:latest
```

然后在 Vercel 项目 **Settings → Environment Variables** 添加：

| 变量 | 说明 |
| --- | --- |
| `SUBCONVERTER_BACKEND` | 你的 subconverter 地址，例如 `https://sub.example.com`。必须 HTTPS。 |

重新部署后，客户端下拉框里会多出 Surge 等选项。

> 也可以不配后端，直接在前端「高级选项 → 自定义转换后端」里填地址，
> 这样浏览器会直接访问该后端（需要它允许跨域）。

---

## 四、可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUBCONVERTER_BACKEND` | 空 | 见上一节。 |
| `RULES_BASE_URL` | 部署域名 | 规则源前缀。设为 `github` 则改用 GitHub raw 地址而不用本站镜像。 |
| `SITE_URL` | `VERCEL_PROJECT_PRODUCTION_URL` | 手动指定站点地址。一般不用填。 |

---

## 五、本地运行

```bash
npm start
# 打开 http://127.0.0.1:8080
```

本地跑的**转换逻辑和 Vercel 上完全一样**（同一份 `lib/handler.mjs`）。
首次启动会自动下载一个 subconverter 用于支持 Surge 等额外格式；
不想要的话加 `--no-subconverter`：

```bash
node local/server.mjs --no-subconverter
```

---

## 六、常见问题

**Q：点「预览配置」超时 / 504？**
Vercel 函数有执行时长上限（本项目申请了 60 秒）。首次转换需要加载约 2MB 规则文件，
冷启动会比较慢；之后有缓存就快了。如果持续超时，可以在前端把「启用哪些规则集」里的
「体积大」项（EasyList / EasyPrivacy）关掉。

**Q：预览部署（preview URL）里转换失败？**
Vercel 的 Preview 部署默认开启 Deployment Protection，函数抓取自身静态资源会拿到 401。
生产域名不受影响。要么别用 preview 域名，要么在项目设置里关掉 Deployment Protection。

**Q：报 `No nodes were found` / 没有解析出任何节点？**
跟规则无关，是订阅本身的问题。检查订阅链接是否有效、是否需要特定 User-Agent。
内置引擎支持 base64 订阅、Clash YAML、明文链接列表三种。

**Q：想改分流规则？**
- 只影响自己 → 网页「规则设置」面板，改完生成链接即可
- 影响所有人 → 改 `Clash/config/ZJU.ini` 或 `Clash/*.list`，push 后 Vercel 自动重新部署

详细说明见 [`configs/README.md`](configs/README.md)。

**Q：改完规则 Vercel 会自动更新吗？**
会。Vercel 默认监听 GitHub 的 push 并自动重新部署。也可以在 Vercel 面板手动 Redeploy。

**Q：规则里引用了不存在的策略组，Clash 起不来？**
不会。引擎会自动移除「没有匹配到任何节点」的策略组，并把引用它的规则退回到直连。
不过改了 `ZJU.ini` 之后建议跑一下校验：

```bash
curl -s "http://127.0.0.1:8080/sub?url=<订阅>&config=/Clash/config/ZJU.ini" \
  | node tools/validate-config.mjs -
```

**Q：客户端提示「订阅配置校验失败」？**
说明生成的配置里有当前内核不支持的写法。项目对此有两道防线：
1. 生成时自动过滤内核不支持的规则类型（如 `USER-AGENT`、`URL-REGEX`）；
2. `npm run test:mihomo` 会用**真的 mihomo 内核**加载一遍生成的配置。

改过 `.list` 或 `clash-base.yaml` 之后建议跑一次：

```bash
npm run test:mihomo    # 用真内核校验（首次会自动下载 mihomo，约 16MB）
npm run probe-rules    # 查看当前内核到底支持哪些规则类型
```

**Q：怎么确认部署没问题？**
```bash
npm test    # 108 项测试
```
其中：
- `tools/test-vercel-sim.mjs` 用一个纯静态服务器模拟 Vercel 环境
  （没有文件系统、没有外部后端），验证「只部署到 Vercel 就能用」；
- `tools/test-mihomo.mjs` 用真的 mihomo 内核加载生成的配置，
  并反向验证「故意插入非法规则时测试确实能抓到」。
