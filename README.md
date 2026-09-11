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
- ✅ 175 项自动化测试，包括**用真的 mihomo 内核校验配置**、**真的把 PAC 跑起来验证分流**

### 支持的功能

+ **校园网内开着代理也能正常上浙大内网**（浙大域名走校内 DNS 解析）
+ 支持**不开系统代理**的用法：用 PAC 只让浏览器走代理，其它软件不受影响
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

## 在校园网里怎么用（重要）

**如果你在宿舍 / 实验室 / ZJUWLAN 里上网，一定要选「校园网内」这个场景。**

### 为什么开了代理就上不了内网、还会变慢？

不是规则的问题，是 **DNS** 的问题。

Clash 默认自己配一套公共 DNS（阿里 DoH 等）来解析域名。但浙大很多域名
**只在校内解析，而且解析出来是内网私有 IP**：

| 域名 | 实测解析结果 |
| --- | --- |
| `cc98.org` | `10.10.98.98` |
| `zdbk.zju.edu.cn`（教务网） | `10.202.78.14` |
| `zjusec.com` | `10.214.96.14` |

公共 DNS 要么查不到这些名字，要么返回一个外网地址 —— 于是「打不开」。
就算凑巧解析对了，Clash 自己维护的 DNS 缓存和操作系统的**是两套**，
每次访问都要多转发一次查询，于是「变慢」。

### 两种用法，任选一种

**方式一：开系统代理（推荐，所有软件都生效）**

在网页上把「你在哪里用」选成 **校园网内**，再生成订阅链接。
这样配置会：

- **让 Clash 不再接管 DNS**（`dns.enable: false`），直连域名全部交给系统解析器
- 关掉域名嗅探，减少每个连接的处理开销

校园网里系统 DNS 本来就是 DHCP 下发的校内 DNS，所以解析结果和你**不开代理时完全一致** ——
既不会解析错，也不会多一层转发。

结果：系统代理开着，外网走代理，浙大域名自动直连、解析正确、速度和不挂代理一样。

**想再快一点（可选）**：把校内域名加进客户端的「系统代理绕过」列表，
这样校内流量完全不经过 Clash：

```
*.zju.edu.cn,*.cc98.org,*.zjusec.com,*.zjuers.com,*.pintia.cn
```

Clash Verge：设置 → 系统代理 → 代理绕过。

**方式二：不开系统代理，只用 PAC（只影响浏览器）**

适合「不想让代理接管整个系统」的情况：

1. Clash 保持运行（提供 `127.0.0.1:7890`），但**不要**打开系统代理开关
2. 浏览器 / 系统设置里填「自动代理配置 URL」为 `http://127.0.0.1:8080/proxy.pac`
   - macOS：系统设置 → 网络 → 详细信息 → 代理 → 自动代理配置
   - Windows：设置 → 网络和 Internet → 代理 → 使用自动配置脚本
3. 完成

这种方式的好处：直连的请求**根本不经过 Clash**，DNS 用系统（也就是校园网）的，
所以校内网站天然正常，其它软件（浙大客户端、VPN、终端）完全不受影响。

PAC 有两种模式：

| 模式 | 行为 | 适合 |
| --- | --- | --- |
| 智能（默认） | 只有已知需要翻墙的域名走代理，其余直连 | 省代理流量 |
| 全局 | 只有浙大和国内域名直连，其余全走代理 | 不会有「某个站忘了加名单」的情况 |

> 不在校园网内（放假回家）时，把场景切回「校外 / 家里」，用公共 DNS 的配置。

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
  clash-base-campus.yaml ★ 校园网模式：浙大域名走校内 DNS 10.10.0.21
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
  pac.mjs                PAC 文件生成（不开系统代理的方案）
  base-presets.mjs       可选的基础配置清单
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
  test-pac.mjs           ★ PAC 测试：真的把 PAC 跑起来验证分流判断（36 项）
  test-engine.mjs        引擎端到端测试（27 项）
  test-journey.mjs       用户旅程测试（60 项）
  test-mihomo.mjs        ★ 用真 mihomo 内核校验生成的配置（11 项）
  test-vercel-sim.mjs    Vercel 部署等价性测试（15 项）
  probe-rule-types.mjs   探测内核支持哪些规则类型
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

**你只需要认识一个策略组**：`🚀 节点选择`。在 Clash Verge 的「代理」页面点它，
选一个节点就完事了。其余策略组（`♻️ 自动选择`、`🇭🇰 香港节点`、`📹 油管视频`…）
都是给规则自动调用的，**不需要你手动去选**。

**配置分流方式**：Clash 采用继承式分流配置。例如把「巴哈姆特」选为台湾节点，
它就会使用「台湾节点」分组里当前选中的节点。可以按需调整，
比如把哔哩哔哩设为香港/台湾节点以访问港澳台资源。

推荐把订阅更新间隔设为每小时一次。

![](docs/clash.png)

---

## 开发

```bash
npm test              # 全部 175 项测试
npm run test:parsers  # 只测解析器（离线，不需要服务）
npm run test:pac      # PAC 分流判断（把生成的 PAC 真的执行一遍）
npm run test:engine   # 引擎端到端（需要 npm start 先跑起来）
npm run test:journey  # 模拟同学从开网页到拿到订阅链接的完整流程
npm run test:mihomo   # 用真的 mihomo 内核校验生成的配置（最关键的一关）
npm run test:vercel   # 模拟 Vercel 环境（静态站点 + 无后端，验证零依赖可用）
npm run probe-rules   # 探测当前内核支持哪些规则类型
node tools/diagnose.mjs <域名>  # 诊断某个域名走直连还是代理
npm run check-urls    # 检查规则链接是否失效
npm run build         # 本地构建 Vercel 产物到 public/
```

> `test:mihomo` 会下载 mihomo 官方二进制（约 16MB，只需一次），
> 然后用 `mihomo -t` 真正加载一遍生成的配置。
> 这是唯一能保证客户端不报「订阅配置校验失败」的验证方式。

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

**Q：客户端报「订阅配置校验失败」？**
通常是因为规则文件里混了当前内核不支持的规则类型。
项目已经处理了这个问题：生成配置时会自动过滤掉不支持的规则并给出提示，
`npm run test:mihomo` 会用真内核验证。如果你自己改了 `.list` 文件引入新类型，
跑一下 `npm run probe-rules` 确认内核支持。

**Q：想要 Surge / Quantumult X 格式？**
内置引擎输出 Clash 系配置。需要其它格式的话配一个 `SUBCONVERTER_BACKEND`，
这些 target 会自动转发过去。见 [DEPLOY.md](DEPLOY.md)。

**Q：更多问题？** → [DEPLOY.md](DEPLOY.md) 和 [`configs/README.md`](configs/README.md)

---

## 致谢

+ [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)
+ [subconverter](https://github.com/tindy2013/subconverter)（内置引擎的参考实现）
+ [Clash](https://github.com/Dreamacro/clash) / [Mihomo](https://github.com/MetaCubeX/mihomo)
