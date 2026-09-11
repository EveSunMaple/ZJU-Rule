# ZJU Rule

浙江大学分流规则 + 订阅转换服务。基于 [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR) 修改。

项目使用 CC-BY-SA-4.0 协议发布 [![CC-BY-SA-4.0](https://licensebuttons.net/l/by-sa/4.0/88x31.png)](https://creativecommons.org/licenses/by-sa/4.0/deed.zh)

---

## 这是什么

一个「输入机场订阅链接 → 输出带浙大分流规则的 Clash 订阅」的转换服务，
外加一套让**不写代码的同学也能改分流规则**的可视化设置面板。

### 项目现状

原上游仓库 `ZJU-Rule/ZJU-Rule` 已被删除，原站点 `zjurule.xyz` 也已下线，
历史配置里写死的规则链接**全部 404**。本仓库已经修好并重做：

- ✅ 650 处失效规则链接已修复，`npm run check-urls` 可随时校验
- ✅ **内置纯 JavaScript 转换引擎**（`lib/engine/`），不再依赖 subconverter、Docker 或任何外部服务
- ✅ 规则文件全部自托管，整套配置自包含，不依赖任何第三方仓库
- ✅ **一键部署到 Vercel 即可用**，不需要配置任何后端 → [DEPLOY.md](DEPLOY.md)
- ✅ 网页上可以勾选规则集、添加自定义规则，设置编码进订阅链接，可直接分享
- ✅ 63 项自动化测试覆盖解析器 / 引擎 / Vercel 部署等价性

### 支持的功能

+ ZJU 内网资源/学术资源分流（直连访问 / 内网穿透访问）
+ 节点自动选择 / 故障转移 / 负载均衡
+ Telegram、Youtube、Netflix、动画疯、哔哩哔哩（港澳台解锁）
+ Google 服务、OneDrive、Microsoft 服务、Apple 服务
+ 游戏平台（Steam / Epic / Sony）、网易云音乐（灰色歌曲解锁）
+ 广告拦截 / 应用净化 / AdBlock / 隐私防护
+ 节点分地区管理（香港 / 日本 / 美国 / 台湾 / 狮城 / 韩国）

支持解析的协议：
`SS` `SSR` `VMess` `VLESS` `Trojan` `Hysteria` `Hysteria2` `TUIC` `Socks5` `HTTP(S)`，
订阅格式支持 base64 节点列表、Clash YAML 配置、明文链接列表。

---

## 快速开始

### 自己用（本地跑）

需要 **Node.js 18+**，无需 Docker、无需其他依赖。

```bash
git clone https://github.com/lizhist/ZJU-Rule.git
cd ZJU-Rule
npm start
```

打开 **<http://127.0.0.1:8080>**，粘贴机场订阅链接 → 选客户端 → 生成订阅链接。

```bash
npm start -- --no-subconverter   # 只跑内置引擎（本地不需要额外格式时）
WEB_PORT=9000 npm start          # 换端口
WEB_HOST=0.0.0.0 npm start       # 让局域网内手机也能访问
npm run stop                     # 停止
```

### 给同学用（部署到 Vercel）

3 分钟，不需要服务器，不需要环境变量：

```bash
git push origin master
# 然后到 https://vercel.com/new 导入这个仓库，点 Deploy
```

完整步骤、验证方法、常见问题 → **[DEPLOY.md](DEPLOY.md)**

---

## 怎么改分流规则

网页上有 **「3 · 规则设置」** 面板，不用改代码也能调：

| 我想… | 怎么做 |
| --- | --- |
| 让某个域名走内网直连 | 自定义规则填 `my-lab.zju.edu.cn`，策略选 `✔ ZJU内网` |
| 让某个网站走代理 | 填 `chat.openai.com`，策略选 `🚀 节点选择` |
| 拦截某个广告域名 | 填 `ads.example.com`，策略选 `REJECT` |
| 订阅太大、更新太慢 | 预设选「关闭广告拦截」，或手动关掉标了「体积大」的规则集 |
| 只要最核心的分流 | 预设选「极简」 |

改完之后生成的订阅链接**已经包含你的全部设置**，可以直接发给同学用。

想改仓库里所有人的默认规则？编辑 `Clash/config/ZJU.ini` 和 `Clash/*.list`，
详细教程见 **[`configs/README.md`](configs/README.md)**。

容器里的端口 / DNS / 嗅探设置在同目录的 [`configs/clash-base.yaml`](configs/clash-base.yaml)，
每一项旁边都有中文注释。

---

## 项目结构

```
index.html               转换界面（含规则设置面板）
configs/
  clash-base.yaml        Clash 基础配置：端口 / DNS / 嗅探（可改）
  README.md              怎么改规则的完整教程
Clash/
  *.list                 分流规则文件
  Ruleset/               上游 ACL4SSR 的细分规则
  config/*.ini           规则分组配置（ZJU.ini 为默认）
  GeneralClashConfig.yml 供 subconverter 使用的基础配置
lib/
  engine/                ★ 内置转换引擎（纯 JS，无依赖）
    nodes.mjs            订阅解析：各种分享链接 → 节点对象
    profile.mjs          .ini 规则配置解析
    rules.mjs            .list 规则文件加载
    clash.mjs            Clash YAML 生成
    rename.mjs           节点名美化（国旗 emoji）
    links.mjs            节点 → 分享链接（base64 订阅输出）
  handler.mjs            /sub 统一处理逻辑（本地与 Vercel 共用）
  catalog.mjs            规则清单
  rule-urls.mjs          规则源地址改写
api/
  sub.mjs                Vercel 转换接口
  rules.mjs              Vercel 规则清单接口
local/
  server.mjs             本地服务（静态站点 + 规则改写 + 转换）
  start.sh / stop.sh     启动 / 停止
scripts/
  vercel-build.mjs       Vercel 构建脚本
tools/
  test-parsers.mjs       解析器测试（21 项）
  test-engine.mjs        引擎端到端测试（27 项）
  test-vercel-sim.mjs    Vercel 部署等价性测试（15 项）
  validate-config.mjs    生成的 Clash 配置结构校验
  fix-rule-urls.mjs      失效规则链接修复
DEPLOY.md                部署指南
```

---

## 用 Clash 客户端

各平台客户端：

+ Windows / macOS: [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)
+ macOS: [ClashX Meta](https://github.com/MetaCubeX/ClashX.Meta/releases)
+ Android / HarmonyOS: [Clash Meta for Android](https://github.com/MetaCubeX/ClashMetaForAndroid/releases)
+ iOS: Shadowrocket / Stash / Quantumult X

**建议取消**客户端默认开启的「绕过 10.0.0.0/8」。`10.0.0.0/8` 是 ZJU 内网 IP 段，
ZJU Rule 已正确配置，取消绕过后才能实现内网穿透等高级功能。
以 Clash for Windows 为例：Settings → Bypass Domain/IPNet，删掉以 `10` 开头的行。

**配置分流方式**：Clash 采用继承式分流配置。例如把「巴哈姆特」选为台湾节点，
它就会使用「台湾节点」分组里当前选中的节点。可以按需调整，
比如把哔哩哔哩设为香港/台湾节点以访问港澳台资源。

推荐把订阅更新间隔设为每小时一次。

![](docs/clash.png)

---

## 开发

```bash
npm test              # 全部 63 项测试
npm run test:parsers  # 只测解析器（离线，不需要服务）
npm run test:engine   # 引擎端到端（需要 npm start 先跑起来）
npm run test:vercel   # 模拟 Vercel 环境（静态站点 + 无后端，验证零依赖可用）
npm run check-urls    # 检查规则链接是否失效
npm run build         # 本地构建 Vercel 产物到 public/
```

改完规则后校验生成结果：

```bash
curl -s "http://127.0.0.1:8080/sub?url=<订阅>&config=/Clash/config/ZJU.ini" \
  | node tools/validate-config.mjs -
```

它会检查策略组引用、规则策略、节点字段、MATCH 兜底等
—— 这些都是会让 Clash 直接拒绝启动的问题。

---

## 常见问题

**Q：报 `No nodes were found!`？**
订阅本身的问题，跟规则无关。检查订阅链接是否有效、是否需特定 User-Agent。
内置引擎支持 base64 订阅、Clash YAML、明文链接列表。

**Q：用转换服务会泄露订阅链接吗？**
本地运行时所有数据都在你自己机器上，不经过任何第三方。
部署到公网时，订阅链接只经过你自己部署的实例，本项目不做任何存储。
**不要**使用来路不明的公共转换服务。

**Q：想要 Surge / Quantumult X 格式？**
内置引擎输出 Clash 系配置。需要其它格式的话配一个 `SUBCONVERTER_BACKEND`，
这些 target 会自动转发过去。见 [DEPLOY.md](DEPLOY.md)。

**Q：更多问题？** → [DEPLOY.md](DEPLOY.md) 和 [`configs/README.md`](configs/README.md)

---

## 致谢

+ [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)
+ [subconverter](https://github.com/tindy2013/subconverter)（内置引擎的参考实现）
+ [Clash](https://github.com/Dreamacro/clash) / [Mihomo](https://github.com/MetaCubeX/mihomo)
