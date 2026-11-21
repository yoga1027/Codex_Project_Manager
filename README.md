# Codex Project Manager

Codex Project Manager 是一个 VS Code 扩展。它在右侧提供「会话项目」视图，可以按项目浏览本机 Codex 会话、查看全部历史、搜索对话，并继续原会话。

## 环境要求

- **桌面版 VS Code 1.106 或更新版本**，扩展宿主需要支持 `node:sqlite`。已在 Linux X11 和 VS Code 1.123 上验证。扩展界面在本机运行，会话来自本机 Codex。
- **本机 Codex**，需要能启动 `codex app-server`。VS Code 中安装官方 Codex 扩展 `openai.chatgpt` 后，可以使用其侧栏和编辑器打开会话。也可以单独安装 Codex CLI，通过终端继续会话。
- **Node.js 22.13 或更新版本和 npm**，用于从源码构建和测试。用 VSIX 安装时可直接从下一节的安装步骤开始。

## 克隆、构建和安装

将 `YOUR_GITHUB_USERNAME` 换成仓库所有者的 GitHub 用户名。如果仓库名不同，请使用仓库页面提供的实际克隆地址。

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/Codex_Project_Manager.git
cd Codex_Project_Manager
npm ci
npm test
npm run package
```

打包在项目目录生成 VSIX，文件名中的版本来自 `package.json`。在 VS Code 的「扩展」视图右上角选择「从 VSIX 安装…」，选中生成的文件。也可以在项目目录用以下命令安装当前版本。

```sh
code --install-extension codex-project-manager-0.1.6.vsix
```

如果从 GitHub Releases 下载了 VSIX，可直接安装。安装或更新后，执行 VS Code 命令「开发人员: 重新加载窗口」，然后打开右侧的 **Codex** 标签。也可通过命令面板执行「Codex 项目: 打开会话项目」。

## 配置自己的电脑

在 VS Code 的 **用户设置** 中搜索 `Codex Project Manager`。下列配置随当前 VS Code 用户配置使用，项目目录和对话归属在视图中单独设置。

| 设置 | 默认值 | 用法 |
| --- | --- | --- |
| `codexProjectManager.executable` | 空字符串 | 扩展会在 VS Code 的 `PATH`、用户目录下的常见安装位置和官方 Codex 扩展目录中查找。找不到时填写自己电脑上可执行文件的绝对路径。 |
| `codexProjectManager.separateSidebar` | `false` | 改为 `true` 会使用独立的右侧标签。找不到官方 Codex 侧栏容器时，扩展也会采用这个布局。 |
| `codexProjectManager.hideArchived` | `false` | 隐藏已归档会话，同时应用于项目、全部对话和搜索。也可以在视图工具栏切换。 |

如果终端能运行 `codex`，可用 `command -v codex`（Linux/macOS）或 `Get-Command codex.exe`（Windows PowerShell）查看它的路径。终端和 VS Code 可能使用不同的 `PATH`，此时可在 VS Code 的用户 `settings.json` 中填写绝对路径。以下路径是示例，请换成查询到的实际路径。

**Linux 和 macOS**

```json
{
  "codexProjectManager.executable": "/opt/codex/bin/codex"
}
```

**Windows**

填写实际 `codex.exe` 的路径，JSON 里的反斜杠需要写成 `\\`。

```json
{
  "codexProjectManager.executable": "C:\\Tools\\Codex\\codex.exe"
}
```

如果已有会话位于通过 `CODEX_HOME` 指定的数据目录，启动 VS Code 时需使用同一环境变量。扩展启动的 Codex 进程继承的是 VS Code 的环境。需要配置命令行登录时，请使用自己电脑上的 Codex 登录流程。

## 管理和继续会话

1. **登记项目。** 打开一个本地工作区时，扩展会匹配已登记的项目，或把当前目录登记为新项目。用工具栏的 **+** 可以添加其他目录。要把 Git worktree 或其他目录归到同一项目，在项目上右键选择「添加关联目录…」。多个项目的根目录互相包含时，匹配最具体的目录。
2. **整理旧对话。** 「全部对话」可以浏览 Codex 返回的跨工作区和已归档历史。「未归类」列出尚未匹配项目的对话。选中一条或多条记录并右键选择「添加到项目…」。手动归属优先于目录匹配，可用「清除手动归类」恢复自动匹配。
3. **搜索和排序。** 用视图工具栏搜索或切换归档显示。在同一组内可拖动对话，排序在各列表间共享。新会话和有新活动的会话会置顶，打开旧会话阅读时保留原位置。
4. **继续原会话。** 单击记录在 Codex 侧栏打开。右键也可选择「在 Codex 编辑器打开」或「在终端继续」。终端使用原会话 ID 执行 `codex resume`，原工作目录失效时会请你选择本地目录。

## 兼容性和排查

| 遇到的情况 | 处理方式 |
| --- | --- |
| 找不到「会话项目」 | 从命令面板打开「Codex 项目: 打开会话项目」。嵌入位置不可用时，检查右侧独立标签，或启用 `codexProjectManager.separateSidebar`。 |
| 找不到 Codex 或读不到历史 | 在本机检查 `codex --version`、可执行文件设置和 VS Code 进程的 `CODEX_HOME`。确认本机有已保存的会话，并在工具栏选择「显示已归档对话」和「刷新会话」。 |
| 点选后无法跳转 | 首次打开时，VS Code 可能请求允许打开 Codex 链接。侧栏和编辑器跳转依赖官方扩展当前的会话路由，升级后出现问题时可从右键菜单「在终端继续」。 |
| 打开会话后列表没有自动折叠 | 自动折叠适用于嵌入官方 Codex 侧栏的 Linux X11 会话，需要 `/usr/bin/xdotool`。独立侧栏、Wayland、macOS 和 Windows 上可直接单击「会话项目」标题手动折叠。 |
| 打开远程工作区后没有自动登记项目 | 扩展在桌面 VS Code 本机侧运行，当前只自动登记 `file:` 工作区。WSL、Remote SSH 和其他远程环境中的会话需要按实际本机历史来源核对。 |

## 本机数据与部署

- 会话列表由本机 Codex App Server 提供。项目名、目录映射、手动归属和排序存放在当前 VS Code 用户配置下的扩展数据库 `projects.sqlite` 中。会话内容和原始会话记录由 Codex 管理。
- 换电脑时，在新电脑安装 VSIX、配置本机 Codex，然后用新机器的路径登记项目。安装包只携带扩展清单、说明和编译代码，历史和项目归类通过各自的本机配置使用。
- 发布源码时提交源码、清单和 npm 锁文件。验证后可将生成的 VSIX 上传到 GitHub Releases。项目交接、编辑器本机设置、常见凭据文件、会话日志和数据库均在 Git 忽略范围内。分享使用截图时，请遮盖可能出现的会话标题、项目名称和绝对路径。
