# Notices

这个仓库**不含桌宠本体**，只有那个把她搬出 Antigravity 窗口的宿主外壳。

## 上游

- 桌宠：[**hagemi-pet-agy**](https://github.com/KCFindstr/hagemi-pet-agy)，作者
  [KCFindstr](https://github.com/KCFindstr)，代码 MIT。形象、动画、行为、台词、与 Antigravity
  语言服务的全部交互逻辑都在这里。宿主对她的全部认知都来自这个仓库的公开代码，**没有修改其中任何一行**。
- 美术：[**CrossPet**](https://github.com/lokicorvus/crosspet) 的 `characters/gemini`
  （commit `6e98970`），© lokicorvus 与 CrossPet 贡献者，CC BY-NC-SA 4.0。
  由 hagemi-pet-agy 原样取用，本仓库再原样取用。
  CrossPet 是用 AI 图像工具、从社区的 Gemini 拟人设定（猫耳、异色瞳、四角星发饰）重绘的；
  猫娘版与 B 站的 [ZipZipPipe](https://www.bilibili.com/opus/1233069202138464289) 相关。
  社区设定的权利属于其原始来源。

## 本仓库里有什么不是 MIT

`docs/` 下的截图包含上述美术，因此按 **CC BY-NC-SA 4.0** 使用：非商业、相同方式共享、
保留署名。`icon.icns` 不由仓库分发（`build-app.sh` 现场从插件的 `assets/logo.png` 生成），
生成物同理。

源码部分（`main.cjs`、`preload.cjs`、`build-app.sh`、`start.sh`）是 MIT，见 [LICENSE](LICENSE)。

## 商标

Gemini、Google、Antigravity 是 Google LLC 的商标；Claude 是 Anthropic 的商标；
GPT、ChatGPT 是 OpenAI 的商标。本项目是个人用的非官方作品，与上述公司没有隶属关系，
也未经其背书。

如果哪位原作者觉得这里有冒犯，开个 issue，会改或会撤。
