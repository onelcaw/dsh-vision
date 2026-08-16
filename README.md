# dsh-vision

给 DeepSeek Harness(dsh)用的图片识别桥接插件。DeepSeek 文本模型本身收不了图,这个插件把图片转成文字,让文本模型也能"看懂"图片内容。

## 它做了什么

1. **`vision_read_image` 工具** —— 传入本地文件路径或 http(s) URL,返回图片内容的文字转写。
2. **`(vision)` 模型变体** —— 把 DeepSeek 文本模型克隆成声明了图片输入的 `(vision)` 变体;选它之后,粘贴/上传的图片会在发请求前被自动转成文字证据,再交给真正的文本模型。

## 工作原理(视觉引擎)

调用任意 **OpenAI 兼容的 `/chat/completions` 视觉接口**,把图片以 `image_url`(base64 或 URL)形式发给视觉模型,拿到文字描述后注入对话。

## 配置

配置文件:`~/.dsh-vision/config.json`(首次启动会自动生成,权限 0600)。

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "model": "",
  "prompt": "……(默认转写提示词)……",
  "maxTokens": 2048,
  "timeoutMs": 120000,
  "maxImageBytes": 25165824
}
```

只需填三个字段,举几个常见后端:

| 后端 | baseUrl | model 示例 |
| :-- | :-- | :-- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Gemini(兼容端点) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash`(key 用 Gemini key) |
| Qwen-VL(通义) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| GLM-4V(智谱) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| Ollama 本地 | `http://localhost:11434/v1` | `llava`(apiKey 随便填) |

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add file:"<本插件目录>"
```

安装后**重启 dsh**。

## 使用

- **粘贴/上传图片**:在模型选择器里选中 `DeepSeek (vision)`(或带 `(vision)` 后缀的模型),然后正常粘贴/上传图片并提问,内容会被自动识别。
- **读本地文件/URL**:直接让我调用 `vision_read_image` 工具,传入文件路径或图片 URL。
- 若未选 `(vision)` 变体,纯文本模型会拒绝图片(这是 dsh 的准入规则);这种情况下改走 `vision_read_image` 工具 + 文件路径即可。

## 卸载

```sh
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-vision
```

配置残留可自行删除 `~/.dsh-vision/`。
