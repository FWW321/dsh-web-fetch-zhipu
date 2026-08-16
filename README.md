# dsh-web-fetch-zhipu

Zhipu BigModel 网页抓取 provider,接入 DeepSeek Harness (dsh) web 能力缝
的 **fetch 侧**(`registerFetchProvider`)—— `dsh-web-search-zhipu`
(搜索缝)的孪生。模型面 `web_fetch` 工具(tool-web)经 `ctx.web.fetch()`
走到本 provider,抓取委托给 Zhipu 托管的 web_reader MCP。

## SSRF 姿态(为何这个 provider 无此顾虑)

上游规则:SSRF 防护是 fetch provider 的责任(seam 不看 URL),官方
匿名 HTTP provider 因此未随 rc.6 发布(保险丝 `fetch: false`)。本
provider **委托抓取**:reader 跑在 Zhipu 的网络(bigmodel.cn),不是
本机 —— 经典 SSRF 目标(127.0.0.1/RFC1918/云元数据 169.254.169.254)
从 reader 的位置不可达;本机唯一网络活动是到 MCP 端点的出站 HTTPS。
"provider 自负 SSRF 责任"对委托型 provider 平凡满足。

## 端点(固定)

`open.bigmodel.cn/api/mcp/web_reader/mcp` 的 `webReader` 工具
(streamable-http MCP,Bearer + 会话握手,实测)。端点/工具是代码内
常量 —— Zhipu 变更 = 改常量发版,不走配置旋钮(同搜索孪生哲学:
配置面 = 实际变量面)。

## 配置

Settings 命名空间 `web-fetch-zhipu`(热改)> 行 `config` > 环境变量
(仅 key)。

```yaml
- id: web-fetch-zhipu
  config:
    providerId: zhipu        # fetch 注册表 id;与搜索孪生同 id 不冲突
                              # (两注册表独立 Map,无 WEB_DUPLICATE_PROVIDER)
    # apiKey: <literal>      # 二选一
    apiKeyEnv: ZHIPU_API_KEY
    returnFormat: markdown   # markdown(强) / text
    noCache: false           # 绕 reader 缓存
    readerTimeoutS: 20       # reader 侧单 URL 超时
    maxOutputChars: 200000   # provider 级截断(工具级 fetchMaxOutputChars 再截)
```

启用还需两行用户层重述(插行之外,patch 原有行):

```yaml
# web 行选 fetch provider(与 searchProvider 并存一行声明时注意合并)
- id: web
  config:
    fetchProvider: zhipu
# base 的 tool-web 默认 fetch: false(SSRF 保险丝),显式打开
- id: tool-web
  config:
    fetch: true
```

nixdsh 消费(`webFetch`/`webFetchProviders` 同款选择器形态,缝对称)
时这些行由模块渲染,用户只写声明。

会话管理:initialize → `mcp-session-id` → `notifications/initialized`
握手后 `tools/call`;会话缓存复用,key 变更或服务端丢弃时透明重握手。

可观测:rc.6 无会话事件审计(读路径拒读未知事件类型,自定义事件毒化
日志 —— 见搜索孪生 README 同节说明)。

响应映射:reader 双重编码文档 `{title, url, content, metadata,
external}` → seam `WebFetchResult` `{url, statusCode: 200, body:
{kind: text|html, text}, truncated}`(char 截断置位);reader 侧失败
(bad URL/上游 5xx/超时)是 `isError` 文本 → `WEB_PROVIDER_ERROR`
(文档从未存在,不是"非 2xx 是结果"的场景)。

## 致谢

结构镜像 @fww/dsh-web-search-zhipu(本身跟随 @tonydua/dsh-web-search-exa,
MIT);seam 契约(`WebFetchProvider`/`WebError`/`installSettingsSection`)
来自 @deepseek-ai/dsh-web。

## License

MIT
