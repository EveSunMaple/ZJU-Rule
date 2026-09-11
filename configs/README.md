# 怎么改规则

这个目录和 `../Clash/` 里的文件决定了**哪些流量走代理、哪些直连、哪些拦截**。
不需要懂编程，会照葫芦画瓢就行。

---

## 三种改法，按需选择

| 我想… | 改哪里 | 要不要重新部署 |
| --- | --- | --- |
| 只是自己用着顺手 | 网页上的「**规则设置**」面板 | ❌ 不用，改完直接生成订阅链接 |
| 给所有人加一条规则 | `../Clash/config/ZJU.ini` | ✅ 要（本地跑则刷新即可） |
| 改端口 / DNS / 嗅探 | `clash-base.yaml` | ✅ 要（本地跑则重启服务） |

---

## 一、最常见：加一条自己的规则

### 方式 A：网页上改（推荐，只影响你自己）

打开网页 → **3 · 规则设置** → **自定义规则** → 点「+ 添加一条规则」：

- 填 `my-lab.zju.edu.cn`，策略选 `✔ ZJU内网` → 这个域名走内网直连
- 填 `chat.openai.com`，策略选 `🚀 节点选择` → 这个域名走代理
- 填 `ads.example.com`，策略选 `REJECT` → 拦截这个域名

填域名就行，程序会自动补成 `DOMAIN-SUFFIX,my-lab.zju.edu.cn,✔ ZJU内网`。
想写完整规则也可以，比如 `IP-CIDR,10.20.0.0/16`。

**自定义规则的优先级最高**，会排在所有内置规则前面，所以能覆盖内置规则的行为。

改完之后点「生成订阅链接」，你的所有设置都会编码进链接里 ——
**这条链接可以直接发给同学**，他打开就是你配好的那套规则。

### 方式 B：改仓库文件（影响所有人）

编辑 `../Clash/config/ZJU.ini`，找到对应的规则集，把它替换成你自己的规则文件，
或者直接在 `custom_proxy_group` 里加成员。

---

## 二、规则文件长什么样

`../Clash/*.list` 每行一条规则：

```
# 这是注释，会被忽略
DOMAIN-SUFFIX,zju.edu.cn              # 匹配 zju.edu.cn 及其所有子域名
DOMAIN-KEYWORD,cc98                   # 域名里含 cc98 就匹配
DOMAIN,www.example.com                # 精确匹配这一个域名
IP-CIDR,10.0.0.0/8,no-resolve         # 匹配这个 IP 段
IP-CIDR6,fc00::/7,no-resolve          # IPv6 网段
```

**注意：`.list` 文件里不写策略**。「这条规则走哪个策略组」是由 `ZJU.ini` 里的
`ruleset=策略组,规则文件` 决定的。同一个 `.list` 可以挂到不同策略组上。

支持的规则类型（Clash / Mihomo）：

| 类型 | 作用 | 例子 |
| --- | --- | --- |
| `DOMAIN-SUFFIX` | 域名后缀（最常用） | `DOMAIN-SUFFIX,zju.edu.cn` |
| `DOMAIN-KEYWORD` | 域名关键词 | `DOMAIN-KEYWORD,bilibili` |
| `DOMAIN` | 精确域名 | `DOMAIN,www.google.com` |
| `IP-CIDR` / `IP-CIDR6` | IP 网段，可加 `no-resolve` | `IP-CIDR,10.0.0.0/8,no-resolve` |
| `GEOIP` | 按国家/地区 | `GEOIP,CN` |
| `PROCESS-NAME` | 按进程名（桌面端） | `PROCESS-NAME,Telegram.exe` |
| `USER-AGENT` | 按 UA（移动端） | `USER-AGENT,*youtube*` |
| `URL-REGEX` | 按 URL 正则 | `URL-REGEX,^https?://ads\.` |

---

## 三、策略组是怎么配的

`../Clash/config/ZJU.ini` 里两种写法：

```ini
; 1) 规则集：策略组名,规则文件地址
ruleset=✔ ZJU内网,https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/ZJU.list
ruleset=🎯 全球直连,[]GEOIP,CN
ruleset=🐟 漏网之鱼,[]FINAL          ; FINAL = 兜底，必写

; 2) 策略组：名字`类型`成员...
custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT
custom_proxy_group=🇭🇰 香港节点`url-test`(港|HK|Hong Kong)`http://www.gstatic.com/generate_204`300,,50
```

`custom_proxy_group` 的规则：

- 用反引号 `` ` `` 分隔字段
- 类型：`select`（手动选）、`url-test`（自动测速选最快）、`fallback`（故障转移）、`load-balance`（负载均衡）
- 成员写法：
  - `[]名字` → 固定引用某个策略组或 `DIRECT` / `REJECT`
  - `(港|HK)` → 正则，匹配**节点名**，把所有名字里带「港」或「HK」的节点都放进来

> 💡 想让某个策略组自动收录你的节点？在节点名里带上对应关键词即可，
> 比如节点叫 `🇭🇰 香港 01` 就会被 `(港|HK|Hong Kong)` 匹配到。

**没有匹配到任何节点的策略组会被自动移除**，引用它的规则会退回到直连，
所以不用担心「机场没有台湾节点导致 Clash 起不来」。

---

## 三点五、规则文件的两种写法（容易踩坑）

`ruleset=` 后面的规则源有两种写法，两种都支持：

```ini
; 写法一：完整 URL —— 仓库里 ZJU.ini 和所有 *_Online_*.ini 用这个
ruleset=✔ ZJU内网,https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/ZJU.list

; 写法二：相对路径 —— 仓库里 ACL4SSR_*.ini（不带 _Online_ 的那些）用这个
ruleset=✔ ZJU内网,rules/ZJU-Rule/Clash/ZJU.list
```

写法二来自 subconverter 的本地规则目录约定：`rules/ZJU-Rule/` 就是本仓库的一份 checkout，
所以 `rules/ZJU-Rule/Clash/ZJU.list` 等价于仓库根目录下的 `Clash/ZJU.list`。
转换引擎会自动识别这种写法。

> ⚠️ 两种写法都**不要**写成 `Clash/ZJU.list` 之外的相对路径，
> 也别写指向第三方仓库的 `rules/其它仓库/...` —— 那些文件不在本仓库里，加载不到。

**如果规则文件加载失败会怎样？**

- 少数几个失败 → 生成时给出提示，其余规则照常工作
- 全部失败 → 直接报错，不会静默产出一份「能加载但完全不分流」的配置

改完 `ruleset=` 之后建议验证一下：

```bash
curl -s "http://127.0.0.1:8080/sub?url=<订阅>&config=/Clash/config/ZJU.ini" \
  | node tools/validate-config.mjs -
```

---

## 三点八、两个基础配置的区别

| 文件 | 用在哪 | DNS |
| --- | --- | --- |
| `clash-base.yaml` | 校外 / 家里 | 公共 DNS（阿里 DoH 等） |
| `clash-base-campus.yaml` | 宿舍 / 实验室 / ZJUWLAN | 浙大域名走校内 DNS `10.10.0.21` |

校园网版的三个关键设置（**不建议随便改**）：

1. `nameserver` 把 `10.10.0.21` 放第一位
2. `nameserver-policy` 对 `+.zju.edu.cn` / `+.cc98.org` / `+.zjusec.com` 强制指定校内 DNS
   —— 这是「开着代理也能上内网」的关键
3. **不配 `fallback`** —— fallback 会并发查公共 DNS，而内网域名在公共 DNS 上查不到，
   结果可能反而被采纳

网页上的「你在哪里用」选择器就是切这两个文件。也可以直接在链接里改
`&base=/configs/clash-base-campus.yaml`。

---

## 四、改端口 / DNS / 嗅探

编辑 `clash-base.yaml`。这个文件里只有「代理怎么跑」，没有分流规则，
每一个可调项旁边都有中文注释，比如：

```yaml
mixed-port: 7890        # 想换端口就改这里
allow-lan: true         # 想让室友共用你的代理就保持 true
dns:
  nameserver:           # 国内 DNS，一般不用动
    - https://dns.alidns.com/dns-query
```

---

## 五、加完规则怎么验证

```bash
# 1. 语法/结构检查：确认没有引用不存在的策略组等问题
npm start                                          # 另开一个终端
curl -s "http://127.0.0.1:8080/sub?url=<你的订阅>&config=/Clash/config/ZJU.ini" \
  | node tools/validate-config.mjs -

# 2. 死链检查：确认没有指向已失效的规则仓库
npm run check-urls

# 3. 跑全部测试
npm test
```

---

## 六、常见错误

**改了规则但没生效？**
- 本地跑：改完 `.list` / `.ini` 直接刷新网页即可；改完 `clash-base.yaml` 需要重启服务。
- 部署在 Vercel：必须 `git push` 后重新部署。
- 客户端里还要手动更新一次订阅（Clash 一般有「更新」按钮）。

**订阅报错 `No nodes were found`？**
跟规则无关，是订阅本身的问题 —— 检查订阅链接是否有效、是否是标准 base64 订阅。

**某个网站分流不对？**
1. 在网页「自定义规则」里加上它，选对策略组 —— 这最快，且能立刻验证。
2. 验证有效后，再考虑提交到 `ZJU.ini` 让所有人受益。

**想加一整个新的分类（比如「实验室专用」）？**
在 `ZJU.ini` 里加两行：

```ini
ruleset=🧪 实验室,https://raw.githubusercontent.com/<你的用户名>/<仓库>/master/Clash/Lab.list
custom_proxy_group=🧪 实验室`select`[]DIRECT`[]🚀 节点选择
```

再新建 `../Clash/Lab.list` 写规则就行。
