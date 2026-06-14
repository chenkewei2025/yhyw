# Model Card Portal

本项目从 0 重建，包含：

- 前端录入页
- 后台管理页
- Postgres 项目/职别/报名数据
- n8n `model-card` workflow
- n8n `model-card-project-dir` workflow

## 本地开发

```bash
npm install
npm run dev
```

默认端口：

- 本地开发：`3051`
- 对外站点：`https://yh.ccyinghe.com`

## 已完成

- 新前端录入页
- 新后台管理页
- `model_card_portal` 库初始化代码
- `model-card` n8n 工作流生成与发布脚本
- `model-card-project-dir` n8n 工作流生成与发布脚本
- n8n 已创建并激活：
  - `model-card`：`BwtKicjel3qlhvNI`
  - `model-card-project-dir`：`90BZ5NpXDolGCaEX`

## 部署结构

你当前的服务器容器约定：

- `app.js` 保留，跑在 `3050`
- 本项目新增根目录 [index.js](/Users/chenkewei/Desktop/yhyw/index.js)，加载 [server/index.js](/Users/chenkewei/Desktop/yhyw/server/index.js)，跑在 `3051`
- PM2 使用 [ecosystem.config.cjs](/Users/chenkewei/Desktop/yhyw/ecosystem.config.cjs) 同时启动两个进程
- 如果构建目录里没有 `app.js`，PM2 会只启动 `3051` 的新服务

## 环境变量

参考 [.env.example](/Users/chenkewei/Desktop/yhyw/.env.example)。

关键值：

- `PORT=3051`
- `SITE_URL=https://yh.ccyinghe.com`
- `ALLOWED_ORIGINS=https://yh.ccyinghe.com,http://124.221.88.94:86`
- `DATABASE_URL=postgres://postgres:your-postgres-password@postgres:5432/model_card_portal`
- `PGSSLMODE=disable`
- `N8N_WEBHOOK_URL=https://n8n.ccyinghe.com/webhook/model-card`
- `N8N_PROJECT_DIR_WEBHOOK_URL=https://n8n.ccyinghe.com/webhook/model-card-project-dir`
- `N8N_API_BASE_URL=https://n8n.ccyinghe.com/api/v1`
- `N8N_SOURCE_WORKFLOW_ID=86o21cTCHceBCfE1`
- `N8N_API_KEY=你的 n8n API Key`
- `GITHUB_API_BASE_URL=https://api.github.com`
- `GITHUB_API_VERSION=2026-03-10`
- `GITHUB_TOKEN=你的 GitHub Personal Access Token`
- `GITHUB_OWNER=默认查询的 GitHub 用户名或组织名，可留空`
- `SUBMISSION_WORKER_CONCURRENCY=2`，后台 PPTX 生成队列并发数
- `ADMIN_PASSWORD=后台强密码，不要使用默认弱口令`

## GitHub API

GitHub API 通过后端代理调用，token 只放在服务端环境变量里，浏览器不会直接拿到密钥。

建议创建 fine-grained personal access token，并按实际需要给最小权限。只读仓库信息、语言和提交记录时，通常选择目标仓库，并授予 `Contents: Read-only`；公开仓库也可用无私有权限的 token。

已提供后台接口：

- `GET /api/admin/github/status`：检查 GitHub API 是否已配置并返回当前 token 用户
- `GET /api/admin/github/user`：返回当前 token 对应用户
- `GET /api/admin/github/repos`：查询仓库列表，支持 `owner`、`ownerType=user|org|viewer|auto`、`page`、`perPage`
- `GET /api/admin/github/repos/:owner/:repo`：查询仓库详情
- `GET /api/admin/github/repos/:owner/:repo/languages`：查询仓库语言统计
- `GET /api/admin/github/repos/:owner/:repo/commits`：查询最近提交，支持 `sha`、`page`、`perPage`

本地登录后台后可用浏览器访问 `/api/admin/github/status` 验证连接。

## 前端功能

- 报名项目：后台维护，只读下拉
- 项目介绍：自动显示
- 报名职别：后台维护，只读下拉
- 自我介绍文本：提交给 n8n 用 DeepSeek 预处理
- 联系电话、微信号
- 最佳照片、最佳视频
- 剩余照片最多 2 张
- 剩余视频最多 1 个
- 提交按钮
- 下载按钮

## 后台功能

- 管理员登录
- 项目维护：名称、开始结束日期、介绍
- 职别维护：按项目维护
- 项目职别总览
- 按项目/职别筛选报名清单
- Excel 导出

## n8n

工作流生成脚本：

- [scripts/build-n8n-workflow.js](/Users/chenkewei/Desktop/yhyw/scripts/build-n8n-workflow.js)
- [scripts/build-n8n-project-dir-workflow.js](/Users/chenkewei/Desktop/yhyw/scripts/build-n8n-project-dir-workflow.js)
- [scripts/publish-n8n-workflows.js](/Users/chenkewei/Desktop/yhyw/scripts/publish-n8n-workflows.js)

`model-card` workflow 逻辑：

1. Webhook 接收前端素材。
2. DeepSeek 预处理自我介绍文本。
3. 素材按 `姓名+手机号+职别+上传时间` 重命名。
4. 复制 `pptx制作` 中的 `Code in Python1` 和 `Convert to File1`。
5. 仅修改 `Code in Python1` 的 base64 输出字段名称为 `姓名+手机号+职别+上传时间`。
6. 将 PPTX 写入 `/home/node/.n8n-files/model-card/项目名称/`。
7. 删除中间文件，仅保留 PPTX。

## 数据库初始化

服务启动时自动执行：

- 如果 `model_card_portal` 不存在则尝试创建
- 初始化表：
  - `model_card_admins`
  - `model_card_projects`
  - `model_card_roles`
  - `model_card_submissions`
- 自动创建默认管理员

## 发布命令

标准发布流程：本地代码提交后先推送 GitHub，再登录宿主机 `ubuntu@124.221.88.94`，由宿主机拉取 GitHub 最新代码并更新 `nodejs` 容器中 `3051` 端口对应的网站。

路径约定：

- nodejs 容器根路径：`/usr/src/app`
- 宿主机 Docker volume 根路径：`/var/lib/docker/volumes/ubuntu_nodejs_data/_data`
- 3051 网站容器源码：`/usr/src/app/model-card-portal`
- 3051 网站宿主机源码：`/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal`

本地一键发布：

```bash
git add .
git commit -m "更新发布内容"
YES=1 npm run deploy
```

等价命令：

```bash
YES=1 ./deploy.sh ubuntu@124.221.88.94 main
```

发布脚本会：

- 检查本地 Git 工作区必须干净
- `git push origin main` 更新 GitHub
- SSH 到 `ubuntu@124.221.88.94`
- 在宿主机路径 `/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal` 拉取 `origin/main`
- 在容器路径 `/usr/src/app/model-card-portal` 执行 `npm install --omit=dev`
- 如果存在 `build` 脚本则执行 `npm run build`
- 重启 `nodejs` 服务并检查 `https://yh.ccyinghe.com/health`

如果已经在宿主机上，只执行拉取和重启：

```bash
sudo bash /var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal/scripts/deploy-volume-host.sh main
```

生成并发布 n8n 工作流：

```bash
npm run build:n8n
npm run publish:n8n
```

## 重要部署注意事项

- `docker-compose.yml` 里不要再把整个 `/usr/src/app` 挂成匿名卷，否则镜像里的新代码会被空目录覆盖。
- 现在的新服务监听 `3051`，Nginx `86` 端口需要反代到 `nodejs:3051`。
- 本地直接运行时，如果本机不在 Docker 私网 `172.20.0.0/24`，`DATABASE_URL=172.20.0.20` 无法连通，这是正常现象。容器内运行才会通。
